// Cohesion justification: this established integration matrix shares transport/runtime fixtures and
// cross-covers command, settings, agent lifecycle, and completion-delivery invariants.
import assert from "node:assert/strict";
import fs, {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	builtinTool,
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
	driveCustomSelector,
	extensionTool,
} from "../../../test/support.js";
import {
	discoverAgentCatalog,
	discoverAgents,
	formatAgentCatalog,
	formatAgentList,
} from "../src/agents.js";
import { registerSubagentConfigCommand, type SubagentSettingsRuntime } from "../src/config-ui.js";
import { hasUsableAggregator } from "../src/params.js";
import { PI_SUBAGENTS_V1_REPLY, PI_SUBAGENTS_V1_REQUEST } from "../src/public-api.js";
import type { ManagedAgent } from "../src/registry.js";
import { consumeSubagentSettingsNotice } from "../src/settings.js";
import { applyStatefulLimitSetting } from "../src/stateful-limit-ui.js";
import { resolveStatefulLimits } from "../src/stateful-limits.js";
import subagents, {
	buildPiArgs,
	formatTokens,
	formatUsageStats,
	inspectCompletionDeliverySettings,
	inspectDelegationWorkflowSettings,
	normalizeSubagentSettings,
	parsePositiveInteger,
	readSubagentSettings,
	resolveSubagentThinkingLevel,
	sameToolSet,
	saveSubagentConfig,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateBlockingMaxParallelTasksSetting,
	updateCompletionDeliverySetting,
	updateDelegationWorkflowSetting,
	updateStatefulLimitSetting,
} from "../src/subagents.js";

initTheme("dark", false);

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.once("exit", () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

type SchemaObject = {
	properties?: Record<string, SchemaObject>;
	items?: SchemaObject;
	enum?: string[];
	description?: string;
	maxItems?: number;
};

const CORE_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function useFakePiPackage(packageDir: string, cliPath: string): () => void {
	writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: CORE_PACKAGE_NAME, bin: { pi: path.relative(packageDir, cliPath) } }),
	);
	const previous = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = packageDir;
	return () => {
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
	};
}

type SubagentTool = {
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		details?: {
			results: Array<{
				thinkingLevel?: string;
				target?: { cwd: string; trust: { kind: string; projectTrusted: boolean } };
			}>;
			aggregator?: { thinkingLevel?: string };
		};
		isError?: boolean;
	}>;
};

test("subagents registers consistent blocking guidance and one management command", () => {
	const mock = createMockPi();
	subagents(mock.pi);

	assert.deepEqual(
		mock.tools.map((candidate) => candidate.name),
		[
			"subagent",
			"subagent_spawn",
			"subagent_send",
			"subagent_manage",
			"subagent_mailbox",
			"subagent_inspect",
			"subagent_consult",
		],
	);
	const tool = mock.tools[0];
	assert.equal(tool?.name, "subagent");
	assert.equal(tool?.label, "Blocking Subagent");
	assert.match(String(tool?.description), /blocks the main agent/i);
	assert.match(String(tool?.description), /queued steering/i);
	assert.doesNotMatch(String(tool?.description), /subagent_spawn/i);
	assert.match(String(tool?.promptSnippet), /blocking isolated subagents/i);

	const promptGuidelines = tool?.promptGuidelines;
	assert.ok(Array.isArray(promptGuidelines));
	const guidanceText = promptGuidelines.join("\n");
	assert.match(guidanceText, /decide how many subagents to spawn/i);
	assert.match(guidanceText, /no subagent/i);
	assert.match(guidanceText, /blocking subagent.*outputs.*required.*before/i);
	assert.match(guidanceText, /critical-path work.*main agent can perform directly/i);
	assert.doesNotMatch(guidanceText, /critical-path work needed for.*next action/i);
	assert.doesNotMatch(guidanceText, /subagent_spawn/i);
	assert.doesNotMatch(guidanceText, /use subagent parallel mode with 2-4/i);
	assert.match(guidanceText, /configured max 8/i);
	assert.match(String(tool?.description), /maximum parallel worker tasks per call: 8/i);
	assert.match(guidanceText, /omit the aggregator key entirely/i);
	assert.match(guidanceText, /null, empty strings, or an empty object/i);

	const parameters = tool?.parameters as SchemaObject | undefined;
	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	assert.deepEqual(parameters?.properties?.thinkingLevel?.enum, thinkingLevels);
	assert.doesNotMatch(parameters?.properties?.thinkingLevel?.enum?.join(",") ?? "", /huge/);
	assert.match(
		parameters?.properties?.thinkingLevel?.description ?? "",
		/off.*minimal.*xhigh.*max/,
	);
	assert.deepEqual(
		parameters?.properties?.tasks?.items?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.equal(parameters?.properties?.tasks?.maxItems, 64);
	assert.deepEqual(
		parameters?.properties?.chain?.items?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.deepEqual(
		parameters?.properties?.aggregator?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.equal(parameters?.properties?.agent?.enum, undefined);
	assert.equal(parameters?.properties?.tasks?.items?.properties?.agent?.enum, undefined);
	assert.equal(parameters?.properties?.chain?.items?.properties?.agent?.enum, undefined);
	assert.equal(parameters?.properties?.aggregator?.properties?.agent?.enum, undefined);
	assert.match(parameters?.properties?.aggregator?.description ?? "", /omit this key entirely/i);
	assert.match(parameters?.properties?.aggregator?.description ?? "", /treated as absent/i);
	assert.deepEqual(
		[...mock.commands.keys()].filter((name) => name.startsWith("subagents")),
		["subagents"],
	);
	assert.deepEqual(mock.commands.get("subagents")?.getArgumentCompletions?.("s"), [
		{ value: "settings", label: "settings", description: "Configure subagent user settings" },
		{ value: "status", label: "status", description: "Show effective subagent settings" },
	]);
	const toolResultHandler = mock.events.get("tool_result")?.[0];
	assert.deepEqual(
		toolResultHandler?.(
			{ toolName: "subagent", details: { isError: true } },
			createMockContext().ctx,
		),
		{ isError: true },
	);
});

test("blocking parallel calls honor the configured worker limit", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-limit-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		writeFileSync(
			path.join(directory, "pi-subagents.json"),
			JSON.stringify({ blocking: { maxParallelTasks: 1 }, stateful: { enabled: false } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const tool = mock.tools.find((candidate) => candidate.name === "subagent") as SubagentTool;
		assert.ok(tool);
		assert.match(String(mock.tools[0]?.description), /maximum parallel worker tasks per call: 1/i);
		const guidance = mock.tools[0]?.promptGuidelines;
		assert.ok(Array.isArray(guidance));
		assert.match(guidance.join("\n"), /configured max 1/i);

		await assert.rejects(
			() =>
				tool.execute(
					"parallel-limit",
					{
						tasks: [
							{ agent: "scout", task: "first" },
							{
								agent: "reviewer",
								task: "second",
								cwd: path.join(directory, "missing"),
							},
						],
					},
					undefined,
					undefined,
					createMockContext().ctx,
				),
			/configured max is 1/i,
		);

		writeFileSync(
			path.join(directory, "pi-subagents.json"),
			JSON.stringify({ blocking: { maxParallelTasks: 9 }, stateful: { enabled: false } }),
		);
		const raisedMock = createMockPi();
		subagents(raisedMock.pi);
		const raisedTool = raisedMock.tools.find(
			(candidate) => candidate.name === "subagent",
		) as SubagentTool;
		const raisedResult = await raisedTool.execute(
			"raised-parallel-limit",
			{
				tasks: Array.from({ length: 9 }, (_, index) => ({
					agent: "missing",
					task: `task ${index + 1}`,
				})),
			},
			undefined,
			undefined,
			createMockContext().ctx,
		);
		assert.equal(raisedResult.details?.results.length, 9);
		assert.doesNotMatch(raisedResult.content?.[0]?.text ?? "", /too many parallel tasks/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("public preflight returns a side-effect-free launch contract without adding tools", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-preflight-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const context = createMockContext({ cwd: directory });
		const replies: unknown[] = [];
		mock.eventBus.on(PI_SUBAGENTS_V1_REPLY, (reply) => replies.push(reply));
		for (const handler of mock.events.get("session_start") ?? []) {
			await handler({}, context.ctx);
		}
		const registrationsBeforePreflight = mock.tools.length;
		mock.eventBus.emit(PI_SUBAGENTS_V1_REQUEST, {
			requestId: "preflight-1",
			method: "preflight",
			payload: { agent: "scout" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(mock.tools.length, registrationsBeforePreflight);
		assert.equal(new Set(mock.tools.map((tool) => tool.name)).size, 7);
		assert.equal(mock.sentMessages.length, 0);
		assert.equal(replies.length, 1);
		const reply = replies[0] as {
			ok: boolean;
			result: { agent: string; transport: string; effectiveTools: string[]; digest: string };
		};
		assert.equal(reply.ok, true);
		assert.equal(reply.result.agent, "scout");
		assert.equal(reply.result.transport, "subprocess");
		assert.deepEqual(reply.result.effectiveTools, ["read", "grep", "find", "ls", "bash"]);
		assert.match(reply.result.digest, /^[a-f0-9]{24}$/u);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("bare subagents opens a current-session manager and keeps direct routes predictable", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-manager-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);

		const managerRenders: string[][] = [];
		const managerContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const driven = driveCustomSelector(factory, ["\u001b"], 52);
				managerRenders.push(...driven.renders);
				return driven.result;
			},
		});
		for (const handler of mock.events.get("session_start") ?? []) {
			await handler({}, managerContext.ctx);
		}
		await command.handler("", managerContext.ctx);
		assert.equal(managerRenders.length, 1);
		assert.ok(managerRenders.flat().every((line) => visibleWidth(line) <= 52));
		const managerText = managerRenders.flat().join("\n");
		assert.match(managerText, /Subagents/);
		assert.match(managerText, /Delegation: All delegation methods/);
		assert.match(managerText, /Completion: Wait until my next turn/);
		assert.match(managerText, /Agents: 0 active.*0 retained/);
		assert.match(managerText, /Change delegation/);
		assert.match(managerText, /Current agents/);
		assert.match(managerText, /Settings/);
		assert.match(managerText, /Consult resources: Project context only/);
		assert.match(managerText, /Advanced settings/);
		assert.equal(managerContext.notifications.length, 0);

		let nestedCall = 0;
		const nestedRenders: string[][] = [];
		const nestedContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const inputs = nestedCall === 0 ? ["\u001b[B", "\u001b[B", "\r"] : ["\u001b"];
				const driven = driveCustomSelector(factory, inputs, 60);
				nestedRenders[nestedCall++] = driven.renders.flat();
				return driven.result;
			},
		});
		await command.handler("", nestedContext.ctx);
		assert.equal(nestedCall, 2, "settings uses the manager's integrated screen stack");
		assert.match(nestedRenders[0]?.join("\n") ?? "", /Delegation:/);
		assert.match(nestedRenders[1]?.join("\n") ?? "", /Subagent User Settings/);

		let agentRouteCall = 0;
		const agentRouteRenders: string[][] = [];
		const agentRouteContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const inputs = agentRouteCall === 0 ? ["\u001b[B", "\r"] : ["\u001b"];
				const driven = driveCustomSelector(factory, inputs, 60);
				agentRouteRenders[agentRouteCall++] = driven.renders.flat();
				return driven.result;
			},
		});
		await command.handler("", agentRouteContext.ctx);
		assert.equal(agentRouteCall, 3);
		assert.match(agentRouteRenders[1]?.join("\n") ?? "", /Current-session Subagents/);
		assert.match(agentRouteRenders[1]?.join("\n") ?? "", /No current-session subagents/);

		let directCalls = 0;
		const directRenders: string[][] = [];
		const directContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				directCalls++;
				const driven = driveCustomSelector(factory, ["\u001b"], 60);
				directRenders.push(...driven.renders);
				return driven.result;
			},
		});
		await command.handler("settings", directContext.ctx);
		assert.equal(directCalls, 1);
		assert.match(directRenders.flat().join("\n"), /Subagent User Settings/);
		assert.doesNotMatch(directRenders.flat().join("\n"), /Current session/);

		const rpcContext = createMockContext({
			mode: "rpc",
			hasUI: true,
			custom: async () => {
				throw new Error("RPC must not open custom TUI");
			},
		});
		await command.handler("", rpcContext.ctx);
		assert.match(rpcContext.notifications[0]?.message ?? "", /Current session/);
		assert.match(rpcContext.notifications[0]?.message ?? "", /User settings/);

		for (const mode of ["json", "print"]) {
			const headlessContext = createMockContext({
				mode,
				hasUI: false,
				custom: async () => {
					throw new Error(`${mode} mode must not open custom TUI`);
				},
			});
			await command.handler("", headlessContext.ctx);
			assert.deepEqual(headlessContext.notifications, []);
		}

		await command.handler("status", managerContext.ctx);
		assert.match(managerContext.notifications.at(-1)?.message ?? "", /Current session/);
		assert.match(managerContext.notifications.at(-1)?.message ?? "", /User settings/);
		await command.handler("help", managerContext.ctx);
		assert.match(managerContext.notifications.at(-1)?.message ?? "", /configure agent tools/);
		assert.doesNotMatch(managerContext.notifications.at(-1)?.message ?? "", /subagents:/);
		await command.handler("unknown", managerContext.ctx);
		assert.match(
			managerContext.notifications.at(-1)?.message ?? "",
			/Unknown \/subagents subcommand: unknown/,
		);
		await command.handler("settings extra", managerContext.ctx);
		assert.match(
			managerContext.notifications.at(-1)?.message ?? "",
			/Unknown \/subagents subcommand: settings extra/,
		);
		for (const handler of mock.events.get("session_shutdown") ?? []) {
			await handler({}, managerContext.ctx);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("agent tool drafts preserve settings across searchable save, discard, and Escape", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-tool-search-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				future: { kept: true },
				agents: { scout: { tools: ["read", "missing-tool"] } },
			}),
		);
		const mock = createMockPi({
			allTools: [builtinTool("read"), builtinTool("bash"), extensionTool("remote-tool")],
		});
		const runtime: SubagentSettingsRuntime = {
			getBlockingEnabled: () => true,
			getMaxParallelTasks: () => 8,
			getCompletionDelivery: () => "next-turn",
			getConsultResourcePolicy: () => "project-context",
			getConsultationCwdPolicy: () => "anywhere",
			getDelegationCwdPolicy: () => "trusted-targets",
			setMaxParallelTasks: () => undefined,
			setCompletionDelivery: () => undefined,
			setConsultResourcePolicy: () => undefined,
			setConsultationCwdPolicy: () => undefined,
			setDelegationCwdPolicy: () => undefined,
			getRuntimeStatus: () => ({
				enabled: true,
				initialized: true,
				transport: "subprocess",
				completionDelivery: "next-turn",
				limits: resolveStatefulLimits(),
				activeAgents: 0,
				retainedAgents: 0,
			}),
			listAgents: () => [],
			clearAgents: async () => 0,
		};
		registerSubagentConfigCommand(mock.pi, runtime);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const openedScreens: string[] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 70);
				openedScreens.push(stripVTControlCharacters(harness.render().join("\n")));
				if (call === 0) {
					for (let index = 0; index < 3; index += 1) {
						harness.handleInput("tui.select.down");
					}
					harness.handleInput("tui.select.confirm");
				} else if (call === 1 || call === 2) {
					harness.handleInput("tui.select.confirm");
				} else if (call === 3) {
					assert.match(stripVTControlCharacters(harness.render().join("\n")), /missing-tool/);
					for (const input of ["r", "e", "m", "o", "t", "e"]) harness.handleInput(input);
					const filtered = stripVTControlCharacters(harness.render().join("\n"));
					assert.match(filtered, /remote-tool/);
					assert.doesNotMatch(filtered, /\bread\b|\bbash\b|missing-tool/);
					assert.match(filtered, /Save changes/);
					assert.match(filtered, /Discard draft/);
					harness.handleInput("tui.select.confirm");
					for (let index = 0; index < 6; index += 1) harness.handleInput("\u007f");
					const cleared = stripVTControlCharacters(harness.render().join("\n"));
					assert.match(cleared, /› \[x\] remote-tool/);
					assert.match(cleared, /missing-tool.*unavailable/);
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					await new Promise<void>((resolve) => setImmediate(resolve));
				} else {
					harness.handleInput("\u0003");
				}
				call += 1;
				return harness.result;
			},
		});

		await command.handler("", context.ctx);
		assert.equal(call, 5, openedScreens.join("\n---\n"));
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: { kept: true },
			agents: { scout: { tools: ["read", "missing-tool", "remote-tool"] } },
		});
		const savedDocument = readFileSync(settingsPath, "utf8");

		let discardCall = 0;
		const discardContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 70);
				if (discardCall === 0) {
					for (let index = 0; index < 3; index += 1) {
						harness.handleInput("tui.select.down");
					}
					harness.handleInput("tui.select.confirm");
				} else if (discardCall === 1 || discardCall === 2) {
					harness.handleInput("tui.select.confirm");
				} else if (discardCall === 3) {
					for (const input of ["b", "a", "s", "h"]) harness.handleInput(input);
					harness.handleInput("tui.select.confirm");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					assert.match(stripVTControlCharacters(harness.render().join("\n")), /› Discard draft/);
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					await new Promise<void>((resolve) => setImmediate(resolve));
				} else {
					harness.handleInput("\u0003");
				}
				discardCall += 1;
				return harness.result;
			},
		});
		await command.handler("", discardContext.ctx);
		assert.equal(discardCall, 5);
		assert.equal(readFileSync(settingsPath, "utf8"), savedDocument);

		let escapeCall = 0;
		const escapeContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 70);
				if (escapeCall === 0) {
					for (let index = 0; index < 3; index += 1) {
						harness.handleInput("tui.select.down");
					}
					harness.handleInput("tui.select.confirm");
				} else if (escapeCall === 1 || escapeCall === 2) {
					harness.handleInput("tui.select.confirm");
				} else if (escapeCall === 3) {
					for (const input of ["b", "a", "s", "h"]) harness.handleInput(input);
					harness.handleInput("tui.select.confirm");
					harness.handleInput("tui.select.cancel");
					await harness.waitForPending();
					await new Promise<void>((resolve) => setImmediate(resolve));
				} else {
					harness.handleInput("\u0003");
				}
				escapeCall += 1;
				return harness.result;
			},
		});
		await command.handler("", escapeContext.ctx);
		assert.equal(escapeCall, 5);
		assert.equal(readFileSync(settingsPath, "utf8"), savedDocument);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("delegation workflow preview applies async-only on confirmation and cancellation is read-only", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflow-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, JSON.stringify({ future: true }));
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let applyCall = 0;
		let reloads = 0;
		const applyRenders: string[][] = [];
		const applyContext = createMockContext({
			mode: "tui",
			hasUI: true,
			reload: async () => {
				reloads++;
			},
			custom: async (factory: unknown) => {
				const inputs = applyCall === 0 ? ["\r"] : applyCall === 1 ? ["\u001b[B", "\r"] : ["\r"];
				const driven = driveCustomSelector(factory, inputs, 60);
				applyRenders[applyCall++] = driven.renders.flat();
				return driven.result;
			},
		});
		await command.handler("", applyContext.ctx);
		assert.equal(applyCall, 2);
		assert.equal(reloads, 1);
		assert.match(applyContext.notifications.at(-1)?.message ?? "", /run \/reload/i);
		assert.match(applyRenders[0]?.join("\n") ?? "", /Delegation: All delegation methods/);
		assert.match(applyRenders[1]?.join("\n") ?? "", /Async only/);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			blocking: { enabled: false },
			stateful: { enabled: true },
		});

		writeFileSync(settingsPath, JSON.stringify({ future: "unchanged" }));
		const beforeCancel = readFileSync(settingsPath, "utf8");
		const cancelMock = createMockPi();
		subagents(cancelMock.pi);
		const cancelCommand = cancelMock.commands.get("subagents");
		assert.ok(cancelCommand);
		let cancelCall = 0;
		const cancelContext = createMockContext({
			mode: "tui",
			hasUI: true,
			confirm: async () => false,
			custom: async (factory: unknown) => {
				const inputs =
					cancelCall === 0
						? ["\r"]
						: cancelCall === 1
							? ["\u001b[B", "\r"]
							: cancelCall === 2
								? ["\u001b"]
								: ["\u001b"];
				cancelCall++;
				return driveCustomSelector(factory, inputs, 40).result;
			},
		});
		await cancelCommand.handler("", cancelContext.ctx);
		assert.equal(cancelCall, 4);
		assert.equal(readFileSync(settingsPath, "utf8"), beforeCancel);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("configured workflow differences reload from the active tool surface", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflow-partial-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const reloadMock = createMockPi();
		subagents(reloadMock.pi);
		const command = reloadMock.commands.get("subagents");
		assert.ok(command);
		updateDelegationWorkflowSetting("async-only");
		let reloads = 0;
		let call = 0;
		const renders: string[][] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			reload: async () => {
				reloads++;
			},
			custom: async (factory: unknown) => {
				if (call >= 2) throw new Error("workflow should reload after the choice screen");
				const driven = driveCustomSelector(factory, call === 1 ? ["\u001b[B", "\r"] : ["\r"], 40);
				renders[call++] = driven.renders.flat();
				return driven.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 2);
		assert.equal(reloads, 1);
		assert.match(renders[0]?.join("\n") ?? "", /Configured after reload: Async only/);
		assert.match(renders[1]?.join("\n") ?? "", /Current: All delegation methods/);
		assert.ok(renders.flat().every((line) => visibleWidth(line) <= 40));

		reloads = 0;
		const revertChoices = ["Change delegation", "All delegation methods", undefined, undefined];
		const revertContext = createMockContext({
			mode: "tui",
			hasUI: true,
			reload: async () => {
				reloads++;
			},
			select: async () => revertChoices.shift(),
		});
		await command.handler("", revertContext.ctx);
		assert.equal(reloads, 0);
		assert.equal(inspectDelegationWorkflowSettings().value, "all");
		assert.match(
			revertContext.notifications.at(-1)?.message ?? "",
			/current tool surface already matches/i,
		);

		for (const width of [40, 60, 100]) {
			const widthMock = createMockPi();
			subagents(widthMock.pi);
			const widthCommand = widthMock.commands.get("subagents");
			assert.ok(widthCommand);
			let lines: string[] = [];
			const widthContext = createMockContext({
				mode: "tui",
				hasUI: true,
				custom: async (factory: unknown) => {
					const driven = driveCustomSelector(factory, ["\u001b"], width);
					lines = driven.renders.flat();
					return driven.result;
				},
			});
			await widthCommand.handler("", widthContext.ctx);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(lines.join("\n"), /Delegation: All delegation methods/);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("config lifecycle aborts pending confirmations before stateful session handlers", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-config-lifecycle-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const exercise = async (event: "session_start" | "session_shutdown") => {
			let call = 0;
			let observedSignal: AbortSignal | undefined;
			let markStarted: (() => void) | undefined;
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			const context = createMockContext({
				mode: "tui",
				hasUI: true,
				confirm: async (_title: string, _message: string, options?: { signal?: AbortSignal }) => {
					observedSignal = options?.signal;
					markStarted?.();
					return new Promise<boolean>((resolve) => {
						if (observedSignal?.aborted) resolve(false);
						else observedSignal?.addEventListener("abort", () => resolve(false), { once: true });
					});
				},
				custom: async (factory: unknown) => {
					const harness = createCustomSelectorHarness(factory, 60);
					if (call === 0) {
						harness.handleInput("tui.select.confirm");
					} else {
						harness.handleInput("tui.select.down");
						harness.handleInput("tui.select.confirm");
						await harness.waitForPending();
					}
					call++;
					return harness.result;
				},
			});
			const commandRun = command.handler("", context.ctx);
			await started;
			assert.equal(observedSignal?.aborted, false);
			const handlers = mock.events.get(event) ?? [];
			assert.ok(handlers.length > 1);
			await handlers[0]?.({}, context.ctx);
			assert.equal(observedSignal?.aborted, true);
			await commandRun;
			assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);
		};

		await exercise("session_start");
		await exercise("session_shutdown");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("delegation workflow blocks reload while detached agents are retained", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflow-retained-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		let reloads = 0;
		const runtime: SubagentSettingsRuntime = {
			getBlockingEnabled: () => true,
			getMaxParallelTasks: () => 8,
			getCompletionDelivery: () => "next-turn",
			getConsultResourcePolicy: () => "project-context",
			getConsultationCwdPolicy: () => "anywhere",
			getDelegationCwdPolicy: () => "trusted-targets",
			setMaxParallelTasks: () => undefined,
			setCompletionDelivery: () => undefined,
			setConsultResourcePolicy: () => undefined,
			setConsultationCwdPolicy: () => undefined,
			setDelegationCwdPolicy: () => undefined,
			getRuntimeStatus: () => ({
				enabled: true,
				initialized: true,
				transport: "subprocess",
				completionDelivery: "next-turn",
				limits: resolveStatefulLimits(),
				activeAgents: 1,
				retainedAgents: 2,
			}),
			listAgents: () => [],
			clearAgents: async () => 0,
		};
		registerSubagentConfigCommand(mock.pi, runtime);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			reload: async () => {
				reloads++;
			},
			custom: async (factory: unknown) => {
				const inputs = call === 0 ? ["\r"] : call === 1 ? ["\u001b[B", "\r"] : ["\u001b"];
				call++;
				return driveCustomSelector(factory, inputs, 60).result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 4);
		assert.equal(reloads, 0);
		assert.equal(readFileSync(settingsPath, "utf8"), "{}\n");
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/2 detached subagents.*retained.*1 active.*Current agents/i,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("delegation workflow save failure does not reload or claim application", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflow-save-failure-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		let reloads = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			reload: async () => {
				reloads++;
			},
			custom: async (factory: unknown) => {
				const inputs = call === 0 ? ["\r"] : call === 1 ? ["\u001b[B", "\r"] : ["\u001b"];
				call++;
				return driveCustomSelector(factory, inputs, 60).result;
			},
			confirm: async () => {
				rmSync(settingsPath);
				mkdirSync(settingsPath);
				return true;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 4);
		assert.equal(reloads, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*unchanged/i);
		assert.equal(lstatSync(settingsPath).isDirectory(), true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("current-session manager excludes already closed agent records", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-closed-manager-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		const closedAgent: ManagedAgent = {
			id: "sa_closed",
			agent: "scout",
			rootId: "sa_closed",
			depth: 0,
			children: [],
			state: "closed",
			createdAt: 1,
			updatedAt: 1,
			cwd: process.cwd(),
			history: [],
			mailbox: [],
		};
		const includeClosedArguments: boolean[] = [];
		const runtime: SubagentSettingsRuntime = {
			getBlockingEnabled: () => true,
			getMaxParallelTasks: () => 8,
			getCompletionDelivery: () => "next-turn",
			getConsultResourcePolicy: () => "project-context",
			getConsultationCwdPolicy: () => "anywhere",
			getDelegationCwdPolicy: () => "trusted-targets",
			setMaxParallelTasks: () => undefined,
			setCompletionDelivery: () => undefined,
			setConsultResourcePolicy: () => undefined,
			setConsultationCwdPolicy: () => undefined,
			setDelegationCwdPolicy: () => undefined,
			getRuntimeStatus: () => ({
				enabled: true,
				initialized: true,
				transport: "subprocess",
				completionDelivery: "next-turn",
				limits: resolveStatefulLimits(),
				activeAgents: 0,
				retainedAgents: 0,
			}),
			listAgents(includeClosed = false) {
				includeClosedArguments.push(includeClosed);
				return includeClosed ? [closedAgent] : [];
			},
			clearAgents: async () => 0,
		};
		registerSubagentConfigCommand(mock.pi, runtime);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const renders: string[][] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const inputs = call === 0 ? ["\u001b[B", "\r"] : call === 1 ? ["\r"] : ["\u001b"];
				const driven = driveCustomSelector(factory, inputs, 60);
				renders[call++] = driven.renders.flat();
				return driven.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 3);
		assert.deepEqual(includeClosedArguments, [false]);
		assert.match(renders[1]?.join("\n") ?? "", /No current-session subagents/);
		assert.doesNotMatch(renders[1]?.join("\n") ?? "", /sa_closed/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("delegation workflow settings control the registered tool surface", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflows-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		const cases = [
			{
				name: "all delegation methods",
				settings: {},
				tools: [
					"subagent",
					"subagent_spawn",
					"subagent_send",
					"subagent_manage",
					"subagent_mailbox",
					"subagent_inspect",
					"subagent_consult",
				],
			},
			{
				name: "async only",
				settings: { blocking: { enabled: false }, stateful: { enabled: true } },
				tools: [
					"subagent_spawn",
					"subagent_send",
					"subagent_manage",
					"subagent_mailbox",
					"subagent_inspect",
				],
			},
			{
				name: "blocking only",
				settings: { blocking: { enabled: true }, stateful: { enabled: false } },
				tools: ["subagent", "subagent_inspect", "subagent_consult"],
			},
			{
				name: "disabled",
				settings: { blocking: { enabled: false }, stateful: { enabled: false } },
				tools: ["subagent_inspect"],
			},
		] as const;
		for (const scenario of cases) {
			writeFileSync(settingsPath, JSON.stringify(scenario.settings));
			const mock = createMockPi();
			subagents(mock.pi);
			assert.deepEqual(
				mock.tools.map((tool) => tool.name),
				scenario.tools,
				scenario.name,
			);
			assert.ok(mock.commands.has("subagents"), `${scenario.name} keeps recovery commands`);
			if (scenario.name === "async only") {
				const spawnGuidance = mock.tools.find(
					(tool) => tool.name === "subagent_spawn",
				)?.promptGuidelines;
				assert.ok(Array.isArray(spawnGuidance));
				assert.doesNotMatch(spawnGuidance.join("\n"), /blocking subagent/i);
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("disabled stateful settings do not advertise unavailable lifecycle tools", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-guidance-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		writeFileSync(
			path.join(directory, "pi-subagents.json"),
			JSON.stringify({ stateful: { enabled: false } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			["subagent", "subagent_inspect", "subagent_consult"],
		);
		const blockingTool = mock.tools[0];
		assert.doesNotMatch(String(blockingTool?.description), /subagent_spawn/i);
		assert.doesNotMatch(
			Array.isArray(blockingTool?.promptGuidelines) ? blockingTool.promptGuidelines.join("\n") : "",
			/subagent_spawn/i,
		);
		assert.equal(mock.commands.has("subagents:agents"), false);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const renders: string[][] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const driven = driveCustomSelector(factory, ["\u001b"], 60);
				renders.push(...driven.renders);
				return driven.result;
			},
		});
		await command.handler("", context.ctx);
		assert.match(renders.flat().join("\n"), /Delegation: Blocking only/);
		await command.handler("help", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /configure agent tools/);
		assert.doesNotMatch(context.notifications.at(-1)?.message ?? "", /subagents:/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("advanced settings validates, saves, and immediately applies the blocking parallel limit", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-limit-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ future: true, blocking: { futureBlocking: "keep" } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);

		let applyCall = 0;
		const applyFrames: string[] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				const frame = stripVTControlCharacters(harness.render().join("\n"));
				applyFrames.push(frame);
				if (applyCall === 0) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (applyCall === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (applyCall === 2) {
					assert.match(frame, /Maximum Parallel Workers/);
					assert.match(frame, /Current: 8/);
					harness.setFocused(true);
					harness.handleInput("3");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else {
					assert.match(frame, /Maximum parallel workers.*Current: 3/s);
					harness.handleInput("\u0003");
				}
				applyCall++;
				return harness.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(applyCall, 4, applyFrames.join("\n---\n"));
		assert.ok(
			applyFrames.flatMap((frame) => frame.split("\n")).every((line) => visibleWidth(line) <= 60),
		);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			blocking: { futureBlocking: "keep", maxParallelTasks: 3 },
		});
		assert.match(context.notifications.at(-1)?.message ?? "", /saved and applied.*3/i);
		const refreshedBlocking = mock.tools.filter((tool) => tool.name === "subagent").at(-1);
		assert.match(
			String(refreshedBlocking?.description),
			/maximum parallel worker tasks per call: 3/i,
		);
		assert.match(
			Array.isArray(refreshedBlocking?.promptGuidelines)
				? refreshedBlocking.promptGuidelines.join("\n")
				: "",
			/configured max 3/i,
		);
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /maximum parallel workers: 3/i);

		writeFileSync(
			settingsPath,
			JSON.stringify({ future: true, blocking: { futureBlocking: "keep", maxParallelTasks: 2 } }),
		);
		let staleCall = 0;
		const staleContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				if (staleCall === 0) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (staleCall === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (staleCall === 2) {
					harness.setFocused(true);
					harness.handleInput("3");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else {
					harness.handleInput("\u0003");
				}
				staleCall++;
				return harness.result;
			},
		});
		await command.handler("", staleContext.ctx);
		assert.equal(staleCall, 4);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			blocking: { futureBlocking: "keep", maxParallelTasks: 3 },
		});

		const savedDocument = readFileSync(settingsPath, "utf8");
		let invalidCall = 0;
		const invalidContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				if (invalidCall === 0) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (invalidCall === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (invalidCall === 2) {
					harness.setFocused(true);
					harness.handleInput("0");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
					assert.match(stripVTControlCharacters(harness.render().join("\n")), /0/);
					harness.handleInput("tui.select.cancel");
					await harness.resultPromise;
				} else {
					harness.handleInput("\u0003");
				}
				invalidCall++;
				return harness.result;
			},
		});
		await command.handler("", invalidContext.ctx);
		assert.equal(invalidCall, 4);
		assert.match(invalidContext.notifications.at(-1)?.message ?? "", /whole number from 1 to 64/i);
		assert.equal(readFileSync(settingsPath, "utf8"), savedDocument);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detached-limit UI saves several startup limits without mutating the current runtime", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-detached-limit-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ future: true, stateful: { futureStateful: "keep" } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const frames: string[] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 64);
				const frame = stripVTControlCharacters(harness.render().join("\n"));
				frames.push(frame);
				if (call === 0 || call === 1) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 2) {
					assert.match(frame, /Detached Agent Limits/);
					assert.match(frame, /Retained agents.*Current 16.*configured 16/s);
					for (const label of [
						"Active turns",
						"Children per agent",
						"Agent tree depth",
						"Stored agents",
					]) {
						assert.match(frame, new RegExp(label));
					}
					harness.handleInput("tui.select.confirm");
				} else if (call === 3) {
					assert.match(frame, /Current session: 16/);
					harness.setFocused(true);
					harness.handleInput("20");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else if (call === 4) {
					assert.match(frame, /Retained agents.*Current 16.*configured 20/s);
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 5) {
					assert.match(frame, /Current session: 4/);
					harness.setFocused(true);
					harness.handleInput("6");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else if (call === 6) {
					assert.match(frame, /Retained agents.*Current 16.*configured 20/s);
					assert.match(frame, /Active turns.*Current 4.*configured 6/s);
					harness.handleInput("tui.select.cancel");
				} else if (call === 7) {
					assert.match(frame, /Advanced Subagent Settings/);
					harness.handleInput("tui.select.cancel");
				} else {
					assert.match(frame, /Configured after reload: retained agents 20.*active turns 6/s);
					harness.handleInput("\u0003");
				}
				call++;
				return harness.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 9, frames.join("\n---\n"));
		assert.ok(
			frames.flatMap((frame) => frame.split("\n")).every((line) => visibleWidth(line) <= 64),
		);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			stateful: { futureStateful: "keep", maxAgents: 20, maxActiveTurns: 6 },
		});
		assert.match(context.notifications.at(-1)?.message ?? "", /applies after \/reload/i);

		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /detached limits: 16 retained/i);
		assert.match(context.notifications.at(-1)?.message ?? "", /configured retained agents: 20/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detached-limit lowering cancellation and stale previews leave settings unchanged", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-detached-preview-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const controller = new AbortController();
		const agents: ManagedAgent[] = [
			{
				id: "older",
				agent: "scout",
				rootId: "older",
				depth: 0,
				children: [],
				state: "idle",
				createdAt: 1,
				updatedAt: 1,
				cwd: process.cwd(),
				history: [],
				mailbox: [],
			},
			{
				id: "newer",
				agent: "reviewer",
				rootId: "newer",
				depth: 0,
				children: [],
				state: "idle",
				createdAt: 2,
				updatedAt: 2,
				cwd: process.cwd(),
				history: [],
				mailbox: [],
			},
		];
		const runtime = {
			getRuntimeStatus: () => ({
				enabled: true,
				initialized: true,
				transport: "subprocess" as const,
				completionDelivery: "next-turn" as const,
				limits: resolveStatefulLimits(),
				activeAgents: 0,
				retainedAgents: agents.length,
			}),
			listAgents: () => [...agents],
		};
		const invalid = createMockContext({ mode: "tui", hasUI: true });
		assert.deepEqual(
			await applyStatefulLimitSetting("maxDepth", "-1", invalid.ctx, runtime, {
				signal: controller.signal,
				isCurrent: () => true,
			}),
			{ kind: "rejected" },
		);
		assert.match(invalid.notifications.at(-1)?.message ?? "", /whole number.*0 or greater/i);
		assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);

		let preview = "";
		const cancelled = createMockContext({
			mode: "tui",
			hasUI: true,
			confirm: async (_title: string, message: string) => {
				preview = message;
				return false;
			},
		});
		assert.deepEqual(
			await applyStatefulLimitSetting("maxAgents", "1", cancelled.ctx, runtime, {
				signal: controller.signal,
				isCurrent: () => true,
			}),
			{ kind: "rejected" },
		);
		assert.match(preview, /omit 1 currently retained agent record/i);
		assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);

		const stale = createMockContext({
			mode: "tui",
			hasUI: true,
			confirm: async () => {
				agents.push({ ...agents[0], id: "changed", rootId: "changed", updatedAt: 3 });
				return true;
			},
		});
		assert.deepEqual(
			await applyStatefulLimitSetting("maxAgents", "1", stale.ctx, runtime, {
				signal: controller.signal,
				isCurrent: () => true,
			}),
			{ kind: "rejected" },
		);
		assert.match(stale.notifications.at(-1)?.message ?? "", /agents changed.*review/i);
		assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);

		const replacedController = new AbortController();
		let current = true;
		const replaced = createMockContext({
			mode: "tui",
			hasUI: true,
			confirm: async () => {
				current = false;
				replacedController.abort();
				return true;
			},
		});
		assert.deepEqual(
			await applyStatefulLimitSetting("maxAgents", "1", replaced.ctx, runtime, {
				signal: replacedController.signal,
				isCurrent: () => current,
			}),
			{ kind: "close" },
		);
		assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detached-limit previews depth and stored-record reductions", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-detached-preview-fields-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const root: ManagedAgent = {
			id: "root",
			agent: "scout",
			rootId: "root",
			depth: 0,
			children: ["child"],
			state: "idle",
			createdAt: 1,
			updatedAt: 1,
			cwd: process.cwd(),
			history: [],
			mailbox: [],
		};
		const child: ManagedAgent = {
			...root,
			id: "child",
			rootId: "root",
			parentId: "root",
			depth: 1,
			children: [],
			updatedAt: 3,
		};
		const other: ManagedAgent = {
			...root,
			id: "other",
			rootId: "other",
			children: [],
			updatedAt: 2,
		};
		for (const [field, value, agents] of [
			["maxDepth", "0", [root, child]],
			["maxStoredAgents", "1", [root, other]],
		] as const) {
			let preview = "";
			const context = createMockContext({
				mode: "tui",
				hasUI: true,
				confirm: async (_title: string, message: string) => {
					preview = message;
					return false;
				},
			});
			const runtime = {
				getRuntimeStatus: () => ({
					enabled: true,
					initialized: true,
					transport: "subprocess" as const,
					completionDelivery: "next-turn" as const,
					limits: resolveStatefulLimits(),
					activeAgents: 0,
					retainedAgents: agents.length,
				}),
				listAgents: () => [...agents],
			};
			assert.deepEqual(
				await applyStatefulLimitSetting(field, value, context.ctx, runtime, {
					signal: new AbortController().signal,
					isCurrent: () => true,
				}),
				{ kind: "rejected" },
			);
			assert.match(preview, /omit 1 currently retained agent record/i);
			assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detached-limit save failure preserves the previous configured value", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-detached-save-failure-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const settingsPath = path.join(directory, "pi-subagents.json");
	writeFileSync(settingsPath, "{}\n");
	const originalRenameSync = fs.renameSync;
	try {
		fs.renameSync = (() => {
			throw new Error("rename unavailable");
		}) as typeof fs.renameSync;
		syncBuiltinESMExports();
		const context = createMockContext({ mode: "tui", hasUI: true });
		const runtime = {
			getRuntimeStatus: () => ({
				enabled: true,
				initialized: true,
				transport: "subprocess" as const,
				completionDelivery: "next-turn" as const,
				limits: resolveStatefulLimits(),
				activeAgents: 0,
				retainedAgents: 0,
			}),
			listAgents: () => [],
		};
		assert.deepEqual(
			await applyStatefulLimitSetting("maxAgents", "20", context.ctx, runtime, {
				signal: new AbortController().signal,
				isCurrent: () => true,
			}),
			{ kind: "rejected" },
		);
		assert.equal(readFileSync(settingsPath, "utf8"), "{}\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*unchanged/i);
	} finally {
		fs.renameSync = originalRenameSync;
		syncBuiltinESMExports();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("parallel-limit UI keeps the runtime unchanged after a settings save failure", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-limit-failure-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		const registerTool = mock.rawPi.registerTool.bind(mock.rawPi);
		let failNextSave = true;
		mock.rawPi.registerTool = (candidate: unknown) => {
			registerTool(candidate);
			if (failNextSave && (candidate as { name?: string }).name === "subagent") {
				failNextSave = false;
				rmSync(settingsPath);
				mkdirSync(settingsPath);
			}
		};
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				if (call === 0) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 2) {
					harness.setFocused(true);
					harness.handleInput("4");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
					assert.match(stripVTControlCharacters(harness.render().join("\n")), /4/);
					harness.handleInput("\u0003");
					await harness.resultPromise;
				} else {
					harness.handleInput("\u0003");
				}
				call++;
				return harness.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 3);
		assert.match(context.notifications.at(-1)?.message ?? "", /were not saved/i);
		const blocking = mock.tools.filter((tool) => tool.name === "subagent").at(-1);
		assert.match(String(blocking?.description), /maximum parallel worker tasks per call: 8/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("parallel-limit UI leaves settings and runtime unchanged after registration failure", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-limit-runtime-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		const blocking = mock.tools.find((tool) => tool.name === "subagent") as SubagentTool;
		assert.ok(blocking);
		const registerTool = mock.rawPi.registerTool.bind(mock.rawPi);
		mock.rawPi.registerTool = (candidate: unknown) => {
			if ((candidate as { name?: string }).name === "subagent") {
				throw new Error("registration failed");
			}
			registerTool(candidate);
		};
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				if (call === 0) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else {
					harness.setFocused(true);
					harness.handleInput("4");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
					harness.handleInput("\u0003");
					await harness.resultPromise;
				}
				call++;
				return harness.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 3);
		assert.equal(readFileSync(settingsPath, "utf8"), "{}\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /not applied.*unchanged/i);
		await assert.rejects(
			() =>
				blocking.execute(
					"runtime-rollback",
					{
						tasks: Array.from({ length: 9 }, (_, index) => ({
							agent: "missing",
							task: `task ${index + 1}`,
						})),
					},
					undefined,
					undefined,
					createMockContext().ctx,
				),
			/configured max is 8/i,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI preserves unknown JSON and applies completion delivery immediately", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ futureOption: true, stateful: { futureStatefulOption: "keep" } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const initialSpawnGuidance = mock.tools.find(
			(tool) => tool.name === "subagent_spawn",
		)?.promptGuidelines;
		assert.ok(Array.isArray(initialSpawnGuidance));
		assert.match(initialSpawnGuidance.join("\n"), /next-turn.*default/i);
		assert.doesNotMatch(initialSpawnGuidance.join("\n"), /even when.*final answer.*depends/i);
		let customCalls = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				customCalls++;
				const inputs =
					customCalls === 1
						? ["\u001b[B", "\u001b[B", "\u001b[B", "\r", "\u001b"]
						: ["\u001b[B", "\u001b[B", "\r", "\u001b"];
				return driveCustomSelector(factory, inputs).result;
			},
		});
		await command.handler("settings", context.ctx);
		assert.equal(customCalls, 1);
		const updatedSpawnGuidance = mock.tools
			.filter((tool) => tool.name === "subagent_spawn")
			.at(-1)?.promptGuidelines;
		assert.ok(Array.isArray(updatedSpawnGuidance));
		assert.match(updatedSpawnGuidance.join("\n"), /auto-resume/i);
		assert.match(updatedSpawnGuidance.join("\n"), /even when.*final answer.*depends/i);
		assert.doesNotMatch(updatedSpawnGuidance.join("\n"), /next-turn.*default/i);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			futureOption: true,
			stateful: {
				futureStatefulOption: "keep",
				completionDelivery: "auto-resume",
			},
		});
		updateAgentToolsSetting("scout", ["read"]);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			futureOption: true,
			stateful: {
				futureStatefulOption: "keep",
				completionDelivery: "auto-resume",
			},
			agents: { scout: { tools: ["read"] } },
		});
		await command.handler("status", context.ctx);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/Completion: Resume automatically when finished/,
		);
		assert.match(context.notifications.at(-1)?.message ?? "", /User settings/);

		await command.handler("settings", context.ctx);
		assert.equal(customCalls, 2);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			futureOption: true,
			stateful: {
				futureStatefulOption: "keep",
				completionDelivery: "auto-resume",
			},
			agents: { scout: { tools: ["read"] } },
			consult: { resources: "none" },
		});
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /No inherited resources/);
		const refreshedConsultDescription = mock.tools
			.filter((tool) => tool.name === "subagent_consult")
			.at(-1)?.description;
		assert.match(String(refreshedConsultDescription), /configured trusted-target resources: none/i);

		const nonTui = createMockContext({
			mode: "json",
			hasUI: true,
			custom: async () => {
				throw new Error("custom UI must not open");
			},
		});
		await command.handler("settings", nonTui.ctx);
		assert.match(nonTui.notifications[0]?.message ?? "", /Edit settings manually/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI applies FleetView now and lifecycle metadata after reload", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-additive-settings-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const down = call++ === 0 ? 4 : 5;
				return driveCustomSelector(factory, [
					...Array.from({ length: down }, () => "\u001b[B"),
					"\r",
					"\u001b",
				]).result;
			},
		});
		await command.handler("settings", context.ctx);
		await command.handler("settings", context.ctx);
		assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "pi-subagents.json"), "utf8")), {
			stateful: { fleetView: "active", lifecycleArtifacts: "metadata" },
		});
		assert.match(
			context.notifications.map((entry) => entry.message).join("\n"),
			/FleetView.*applied|Show active agents/i,
		);
		assert.match(
			context.notifications.map((entry) => entry.message).join("\n"),
			/Metadata after reload.*reload/i,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("FleetView runtime failure leaves settings and effective state unchanged", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fleet-rollback-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) =>
				driveCustomSelector(factory, [
					"\u001b[B",
					"\u001b[B",
					"\u001b[B",
					"\u001b[B",
					"\r",
					"\u001b",
				]).result,
		});
		for (const handler of mock.events.get("session_start") ?? []) {
			await handler({}, context.ctx);
		}
		(context.ctx as { ui: { setWidget: () => void } }).ui.setWidget = () => {
			throw new Error("widget failed");
		};
		await command.handler("settings", context.ctx);
		assert.equal(readFileSync(settingsPath, "utf8"), "{}\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /not applied.*roll back fleetview/i);
		for (const handler of mock.events.get("session_shutdown") ?? []) {
			await handler({}, context.ctx);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI exposes and immediately applies both cwd policies", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cwd-settings-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		let rendered = "";
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 90);
				rendered += stripVTControlCharacters(harness.render().join("\n"));
				const inputs = call++ === 0 ? ["\r", "\u001b"] : ["\u001b[B", "\r", "\u001b"];
				for (const input of inputs) harness.handleInput(input);
				return harness.result;
			},
		});
		await command.handler("settings", context.ctx);
		await command.handler("settings", context.ctx);
		assert.match(rendered, /Read-only consultation target/);
		assert.match(rendered, /General delegation target/);
		assert.match(rendered, /Consultation resources for trusted targets/);
		assert.match(rendered, /When async work finishes/);
		assert.match(rendered, /not filesystem access or sandboxing/i);
		assert.match(rendered, /Pi \/trust/);
		assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "pi-subagents.json"), "utf8")), {
			cwdPolicy: {
				consultation: "current-workspace",
				delegation: "current-workspace",
			},
		});
		const blockingDescription = mock.tools
			.filter((tool) => tool.name === "subagent")
			.at(-1)?.description;
		const spawnDescription = mock.tools
			.filter((tool) => tool.name === "subagent_spawn")
			.at(-1)?.description;
		const consultDescription = mock.tools
			.filter((tool) => tool.name === "subagent_consult")
			.at(-1)?.description;
		assert.match(String(blockingDescription), /target policy: current-workspace/i);
		assert.match(String(spawnDescription), /target policy: current-workspace/i);
		assert.match(String(consultDescription), /target policy: current-workspace/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI rolls back after an atomic save failure", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-rollback-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				rmSync(settingsPath);
				mkdirSync(settingsPath);
				return driveCustomSelector(factory, ["\r", "\u001b"]).result;
			},
		});
		await command.handler("settings", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /were not saved/i);
		await command.handler("status", context.ctx);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/Completion: Wait until my next turn/,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent recursion guard rejects nested delegation before spawning", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const originalDepth = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "1";
	try {
		await assert.rejects(
			() =>
				tool.execute(
					"call",
					{ agent: "scout", task: "nested" },
					undefined,
					undefined,
					createMockContext().ctx,
				),
			/recursion depth limit/,
		);
	} finally {
		if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = originalDepth;
	}
});

test("one-shot project agents require project trust even when confirmation is disabled", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-untrusted-"));
	const agentsDir = path.join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "project.md"),
		"---\nname: project\ndescription: project agent\n---\nProject prompt.",
	);
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const spawn = mock.tools.find((candidate) => candidate.name === "subagent_spawn") as
		| SubagentTool
		| undefined;
	assert.ok(spawn);
	try {
		await assert.rejects(
			() =>
				tool.execute(
					"call",
					{
						agent: "project",
						task: "task",
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					createMockContext({ cwd, isProjectTrusted: () => false }).ctx,
				),
			/trusted project/,
		);
		await assert.rejects(
			() =>
				tool.execute(
					"call",
					{ agent: "missing", task: "task", agentScope: "project" },
					undefined,
					undefined,
					createMockContext({ cwd, isProjectTrusted: () => false }).ctx,
				),
			/trusted project/,
		);
		await assert.rejects(
			() =>
				spawn.execute(
					"call",
					{ agent: "missing", task: "task", agentScope: "project" },
					undefined,
					undefined,
					createMockContext({ cwd, isProjectTrusted: () => false }).ctx,
				),
			/trusted project/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("one-shot project confirmation renders project metadata as one safe line", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-confirm-"));
	const agentsDir = path.join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	const agentName = "project\u001b[31m\nspoof";
	writeFileSync(
		path.join(agentsDir, "project.md"),
		`---\nname: "project\\u001b[31m\\nspoof"\ndescription: project agent\n---\nProject prompt.`,
	);
	let confirmation = "";
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const tool = mock.tools[0] as SubagentTool;
		const result = await tool.execute(
			"call",
			{ agent: agentName, task: "task", agentScope: "project" },
			undefined,
			undefined,
			createMockContext({
				cwd,
				hasUI: true,
				isProjectTrusted: () => true,
				confirm: async (title: string, message: string) => {
					confirmation = `${title}\n${message}`;
					return false;
				},
			}).ctx,
		);
		assert.match(result.content?.[0]?.text ?? "", /Canceled/);
		assert.equal(confirmation.includes("\u001b"), false);
		assert.doesNotMatch(confirmation, /\nspoof\nSource:/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("discoverAgents includes built-ins and lets project agents override by name", () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
	const agentsDir = path.join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "scout.md"),
		[
			"---",
			"name: scout",
			"description: Project-specific scout",
			"tools: read,bash",
			"model: gpt-test",
			"thinkingLevel: high",
			"---",
			"Project scout prompt.",
		].join("\n"),
	);

	const baseResult = discoverAgents(cwd, "project");
	const baseScout = baseResult.agents.find((agent) => agent.name === "scout");
	assert.equal(baseScout?.thinkingLevel, "high");

	const result = discoverAgents(cwd, "project", {
		agents: { scout: { timeoutMs: 1234, thinkingLevel: "low" } },
	});
	const scout = result.agents.find((agent) => agent.name === "scout");

	assert.equal(result.projectAgentsDir, agentsDir);
	assert.equal(scout?.source, "project");
	assert.deepEqual(scout?.tools, ["read", "bash"]);
	assert.equal(scout?.model, "gpt-test");
	assert.equal(scout?.thinkingLevel, "low");
	assert.equal(scout?.timeoutMs, 1234);

	const cleared = discoverAgents(cwd, "project", { agents: { scout: { thinkingLevel: null } } });
	assert.equal(cleared.agents.find((agent) => agent.name === "scout")?.thinkingLevel, undefined);
	assert.ok(result.agents.some((agent) => agent.name === "worker" && agent.source === "built-in"));
});

test("built-in reviewer inspects evidence without running verification commands", () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-reviewer-test-"));
	try {
		const reviewer = discoverAgents(cwd, "project").agents.find(
			(agent) => agent.name === "reviewer",
		);

		assert.ok(reviewer);
		assert.match(
			reviewer.systemPrompt,
			/do not edit files or run tests, builds, benchmarks, formatters/i,
		);
		assert.match(reviewer.systemPrompt, /recommend.*commands for the main agent to run/i);
		assert.doesNotMatch(reviewer.systemPrompt, /run safe inspection or test commands/i);
		assert.ok(reviewer.tools?.includes("bash"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("formatAgentList returns concise text and remaining count", () => {
	const agents = discoverAgents(process.cwd(), "project").agents;
	const formatted = formatAgentList(agents, 2);

	assert.match(formatted.text, /scout \(built-in\)/);
	assert.equal(formatted.remaining, Math.max(0, agents.length - 2));
});

test("formatAgentCatalog advertises scope variants deterministically and within bounds", () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-catalog-format-"));
	try {
		const projectAgentsDir = path.join(cwd, ".pi", "agents");
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(
			path.join(projectAgentsDir, "scout.md"),
			"---\nname: scout\ndescription: Project\n---\nProject prompt.",
		);
		writeFileSync(
			path.join(projectAgentsDir, "project.md"),
			"---\nname: project\ndescription: First\n---\nProject prompt.",
		);
		const user = discoverAgentCatalog(cwd, false).user;
		const worker = user.agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		user.agents = user.agents.map((agent) =>
			agent.name === "worker"
				? { ...agent, source: "user" as const, description: "User worker override" }
				: agent,
		);
		const project = discoverAgentCatalog(cwd, true).project;
		assert.ok(project);
		const first = formatAgentCatalog({ user, project }, { maxCharacters: 5_000 });
		const second = formatAgentCatalog({ user, project }, { maxCharacters: 5_000 });
		assert.equal(first.text, second.text);
		assert.match(first.text, /scout \[source: built-in; agentScope: "user"\]/);
		assert.match(first.text, /scout \[source: project; requires agentScope: "project" or "both"/);
		assert.match(first.text, /Project/);
		assert.match(first.text, /Same-name precedence/);
		assert.match(first.text, /project \[source: project/);
		assert.match(first.text, /worker \[source: user; agentScope: "user"/);
		assert.match(first.text, /worker \[source: built-in; requires agentScope: "project"/);
		assert.match(first.text, /both.*selects the user definition/);
		assert.ok(first.text.length <= 5_000);

		const incomplete = formatAgentCatalog({
			user: { ...user, omittedAgentDefinitions: 1 },
			project,
		});
		assert.doesNotMatch(incomplete.text, /source: built-in/);
		const failedDiscovery = formatAgentCatalog({
			user: { ...user, metadataDiscoveryIncomplete: true },
			project,
		});
		assert.match(failedDiscovery.text, /metadata discovery was incomplete/);

		writeFileSync(
			path.join(projectAgentsDir, "huge.md"),
			`---\nname: huge\ndescription: Huge\n---\n${"x".repeat(70 * 1024)}`,
		);
		const boundedProject = discoverAgentCatalog(cwd, true).project;
		const bounded = formatAgentCatalog(
			{ user, project: boundedProject },
			{ maxItems: 2, maxDescriptionLength: 8, maxCharacters: 2_000 },
		);
		assert.match(bounded.text, /additional agent definition.*omitted/);
		assert.doesNotMatch(bounded.text, /x{100}/);
		assert.ok(bounded.omitted > 0);
		assert.match(
			bounded.text,
			new RegExp(`\\[${bounded.omitted} additional agent definitions? omitted`),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session start refreshes detached limits and retains the last valid snapshot after read errors", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-session-limits-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				stateful: {
					maxAgents: 3,
					maxActiveTurns: 2,
					maxChildrenPerAgent: 4,
					maxDepth: 1,
					maxStoredAgents: 6,
				},
			}),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const context = createMockContext();
		const start = async () => {
			for (const handler of mock.events.get("session_start") ?? []) {
				await handler({}, context.ctx);
			}
			return String(
				mock.tools.filter((tool) => tool.name === "subagent_spawn").at(-1)?.description ?? "",
			);
		};

		assert.match(await start(), /3 retained agents, 2 active turns, 4 direct children.*depth 1/i);
		writeFileSync(
			settingsPath,
			JSON.stringify({
				stateful: {
					maxAgents: 7,
					maxActiveTurns: 5,
					maxChildrenPerAgent: 6,
					maxDepth: 2,
					maxStoredAgents: 9,
				},
			}),
		);
		assert.match(await start(), /7 retained agents, 5 active turns, 6 direct children.*depth 2/i);

		writeFileSync(settingsPath, "{ malformed");
		assert.match(await start(), /7 retained agents, 5 active turns, 6 direct children.*depth 2/i);
		assert.match(context.notifications.at(-1)?.message ?? "", /malformed|invalid/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("session start refreshes every agent catalog and gates project metadata on trust", async () => {
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-catalog-user-"));
	const trustedCwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-catalog-trusted-"));
	const untrustedCwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-catalog-untrusted-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			path.join(agentDir, "agents", "api-reviewer.md"),
			"---\nname: api-reviewer\ndescription: Reviews API compatibility\n---\nReview APIs.",
		);
		writeFileSync(
			path.join(agentDir, "agents", "scout.md"),
			"---\nname: scout\ndescription: User scout override\n---\nUser scout.",
		);
		for (const cwd of [trustedCwd, untrustedCwd]) {
			mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
			writeFileSync(
				path.join(cwd, ".pi", "agents", "local.md"),
				"---\nname: local\ndescription: Project-only description\n---\nProject work.",
			);
			writeFileSync(
				path.join(cwd, ".pi", "agents", "scout.md"),
				"---\nname: scout\ndescription: Project scout override\n---\nProject scout.",
			);
		}
		const mock = createMockPi();
		subagents(mock.pi);
		const start = async (cwd: string, trusted: boolean) => {
			const context = createMockContext({ cwd, isProjectTrusted: () => trusted });
			for (const handler of mock.events.get("session_start") ?? []) {
				await handler({}, context.ctx);
			}
			return {
				blocking: String(
					mock.tools.filter((tool) => tool.name === "subagent").at(-1)?.description ?? "",
				),
				spawn: String(
					mock.tools.filter((tool) => tool.name === "subagent_spawn").at(-1)?.description ?? "",
				),
				consult: String(
					mock.tools.filter((tool) => tool.name === "subagent_consult").at(-1)?.description ?? "",
				),
			};
		};
		const untrusted = await start(untrustedCwd, false);
		for (const description of Object.values(untrusted)) {
			assert.match(description, /api-reviewer/);
			assert.match(description, /User scout override/);
			assert.doesNotMatch(
				description,
				/Project-only description|Project scout override|local \[source: project|scout \[source: project/,
			);
		}
		const trusted = await start(trustedCwd, true);
		for (const description of Object.values(trusted)) {
			assert.match(description, /local \[source: project/);
			assert.match(description, /agentScope: "project" or "both"/);
			assert.match(description, /Project-only description/);
			assert.match(description, /Project scout override/);
			assert.doesNotMatch(description, /untrusted/);
		}
		const untrustedAgain = await start(untrustedCwd, false);
		for (const description of Object.values(untrustedAgain)) {
			assert.doesNotMatch(
				description,
				/Project-only description|Project scout override|local \[source: project|scout \[source: project/,
			);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(trustedCwd, { recursive: true, force: true });
		rmSync(untrustedCwd, { recursive: true, force: true });
	}
});

test("subagent settings normalize known override fields only", () => {
	assert.deepEqual(
		normalizeSubagentSettings({
			blocking: { enabled: false },
			stateful: { enabled: true },
			agents: {
				scout: { tools: ["read"], model: null, timeoutMs: 1, thinkingLevel: "medium" },
				clearThinking: { thinkingLevel: null },
				bad: { tools: [1] },
				badThinking: { thinkingLevel: "huge" },
				badTimeout: { timeoutMs: 2_147_483_648 },
			},
		}),
		{
			agents: {
				scout: { tools: ["read"], model: null, timeoutMs: 1, thinkingLevel: "medium" },
				clearThinking: { thinkingLevel: null },
			},
			blocking: { enabled: false },
			stateful: { enabled: true },
		},
	);
	assert.equal(normalizeSubagentSettings({ blocking: { enabled: "no" } }), undefined);
	assert.equal(normalizeSubagentSettings({ blocking: false }), undefined);
	assert.equal(normalizeSubagentSettings({ agents: [] }), undefined);
});

test("session start re-reads settings before reporting warnings", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-session-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				cwdPolicy: {
					consultation: "current-workspace",
					delegation: "current-workspace",
				},
				consult: { resources: "none" },
			}),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		writeFileSync(settingsPath, "{ malformed");
		const context = createMockContext({ mode: "tui", hasUI: true });
		for (const handler of mock.events.get("session_start") ?? []) {
			await handler({}, context.ctx);
		}
		assert.match(context.notifications[0]?.message ?? "", /pi-subagents\.json is invalid/i);
		const latestDescription = (name: string) =>
			String(mock.tools.filter((tool) => tool.name === name).at(-1)?.description);
		assert.match(latestDescription("subagent"), /target policy: current-workspace/i);
		assert.match(latestDescription("subagent_spawn"), /target policy: current-workspace/i);
		assert.match(latestDescription("subagent_consult"), /target policy: current-workspace/i);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /No inherited resources/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent status separates runtime cwd policy from manual configured edits", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-status-cwd-drift-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				cwdPolicy: {
					consultation: "current-workspace",
					delegation: "current-workspace",
				},
			}),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		writeFileSync(
			settingsPath,
			JSON.stringify({
				cwdPolicy: { consultation: "anywhere", delegation: "trusted-targets" },
			}),
		);
		const context = createMockContext({ mode: "tui", hasUI: true });
		const command = mock.commands.get("subagents");
		assert.ok(command);
		await command.handler("status", context.ctx);
		const message = context.notifications.at(-1)?.message ?? "";
		assert.match(message, /Current session[\s\S]*Consultation target: Current workspace only/);
		assert.match(message, /Current session[\s\S]*Delegation target: Current workspace only/);
		assert.match(
			message,
			/User settings[\s\S]*Configured consultation target: Anywhere .* inherit nothing/,
		);
		assert.match(
			message,
			/User settings[\s\S]*Configured delegation target: Current or saved-trusted folders/,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings read legacy files and save to the canonical package filename", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const legacyPath = path.join(directory, "pi-subagents-config.json");
		const canonicalPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			legacyPath,
			JSON.stringify({
				agents: { scout: { tools: ["read"] } },
				blocking: { enabled: false },
				stateful: { completionDelivery: "auto-resume" },
				futureOption: true,
			}),
		);
		assert.deepEqual(inspectDelegationWorkflowSettings(), {
			path: legacyPath,
			value: "async-only",
			source: "user settings",
		});
		assert.deepEqual(inspectCompletionDeliverySettings(), {
			path: legacyPath,
			value: "auto-resume",
			source: "user settings",
		});
		const migrationMock = createMockPi();
		subagents(migrationMock.pi);
		assert.equal(existsSync(canonicalPath), false);
		assert.deepEqual(JSON.parse(readFileSync(legacyPath, "utf8")), {
			agents: { scout: { tools: ["read"] } },
			blocking: { enabled: false },
			stateful: { completionDelivery: "auto-resume" },
			futureOption: true,
		});
		const migrationContext = createMockContext();
		for (const handler of migrationMock.events.get("session_start") ?? []) {
			await handler({}, migrationContext.ctx);
		}
		assert.match(migrationContext.notifications[0]?.message ?? "", /using legacy/i);

		writeFileSync(legacyPath, JSON.stringify({ agents: { scout: { tools: ["bash"] } } }));
		writeFileSync(canonicalPath, JSON.stringify({ agents: { scout: { tools: ["read"] } } }));
		assert.deepEqual(readSubagentSettings(), { agents: { scout: { tools: ["read"] } } });
		assert.deepEqual(inspectDelegationWorkflowSettings(), {
			path: canonicalPath,
			value: "all",
			source: "default",
		});
		assert.equal(inspectCompletionDeliverySettings().path, canonicalPath);
		assert.equal(existsSync(legacyPath), true);

		writeFileSync(canonicalPath, "invalid");
		assert.equal(readSubagentSettings(), undefined);
		assert.equal(inspectDelegationWorkflowSettings().path, canonicalPath);
		assert.match(inspectDelegationWorkflowSettings().error ?? "", /JSON/i);
		assert.equal(readFileSync(legacyPath, "utf8").includes("bash"), true);
		unlinkSync(legacyPath);
		writeFileSync(canonicalPath, JSON.stringify({ agents: { scout: { tools: ["read"] } } }));
		assert.deepEqual(readSubagentSettings(), { agents: { scout: { tools: ["read"] } } });
		assert.equal(consumeSubagentSettingsNotice(), undefined);
		unlinkSync(canonicalPath);
		writeFileSync(legacyPath, "invalid");
		assert.equal(readSubagentSettings(), undefined);
		assert.equal(existsSync(canonicalPath), false);

		writeFileSync(legacyPath, JSON.stringify({ agents: { scout: { tools: ["read"] } } }));
		symlinkSync("missing-target", canonicalPath);
		assert.deepEqual(readSubagentSettings(), { agents: { scout: { tools: ["read"] } } });
		assert.equal(existsSync(legacyPath), true);

		saveSubagentConfig({ stateful: { enabled: false } });
		assert.equal(lstatSync(canonicalPath).isSymbolicLink(), false);
		assert.equal(existsSync(path.join(directory, "missing-target")), false);
		assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), {
			stateful: { enabled: false },
		});
		const ignoredMock = createMockPi();
		subagents(ignoredMock.pi);
		const ignoredContext = createMockContext();
		for (const handler of ignoredMock.events.get("session_start") ?? []) {
			await handler({}, ignoredContext.ctx);
		}
		assert.match(ignoredContext.notifications[0]?.message ?? "", /ignored/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings loaders recheck canonical paths after legacy reads", () => {
	const loaders = [
		{
			name: "runtime",
			load: () => readSubagentSettings()?.blocking?.enabled,
			expected: true,
			expectNotice: true,
		},
		{
			name: "inspector",
			load: () => inspectDelegationWorkflowSettings().value,
			expected: "all",
			expectNotice: false,
		},
	] as const;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const loader of loaders) {
			const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-legacy-read-race-"));
			process.env.PI_CODING_AGENT_DIR = directory;
			try {
				const legacyPath = path.join(directory, "pi-subagents-config.json");
				const canonicalPath = path.join(directory, "pi-subagents.json");
				writeFileSync(legacyPath, JSON.stringify({ blocking: { enabled: false } }));

				const originalReadFileSync = fs.readFileSync;
				let createCanonical = true;
				fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
					const result = originalReadFileSync(...args);
					if (createCanonical && path.resolve(String(args[0])) === legacyPath) {
						createCanonical = false;
						writeFileSync(canonicalPath, JSON.stringify({ blocking: { enabled: true } }));
					}
					return result;
				}) as typeof fs.readFileSync;
				syncBuiltinESMExports();
				try {
					assert.equal(loader.load(), loader.expected, loader.name);
					const notice = consumeSubagentSettingsNotice();
					if (loader.expectNotice) assert.match(notice ?? "", /ignored.*created concurrently/i);
					else assert.equal(notice, undefined);
				} finally {
					fs.readFileSync = originalReadFileSync;
					syncBuiltinESMExports();
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("first subagent settings publication renames a complete temporary inside the mutation lock", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-first-publication-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const settingsPath = path.join(directory, "pi-subagents.json");
	const expected = { stateful: { enabled: false }, future: true };
	const originalRenameSync = fs.renameSync;
	let publicationObserved = false;
	fs.renameSync = ((source, destination) => {
		if (path.resolve(String(destination)) === settingsPath) {
			publicationObserved = true;
			assert.deepEqual(JSON.parse(readFileSync(source, "utf8")), expected);
			assert.equal(lstatSync(`${settingsPath}.mutation-lock`).isDirectory(), true);
		}
		return originalRenameSync(source, destination);
	}) as typeof fs.renameSync;
	syncBuiltinESMExports();
	try {
		saveSubagentConfig(expected);
		assert.equal(publicationObserved, true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), expected);
	} finally {
		fs.renameSync = originalRenameSync;
		syncBuiltinESMExports();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent setting controls seed canonical updates from the active legacy document", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-legacy-update-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const legacyPath = path.join(directory, "pi-subagents-config.json");
		const canonicalPath = path.join(directory, "pi-subagents.json");
		const legacy = {
			future: { retained: true },
			blocking: { enabled: false, futureBlocking: 1 },
			stateful: { completionDelivery: "auto-resume", futureStateful: 2 },
		};
		writeFileSync(legacyPath, JSON.stringify(legacy));

		updateCompletionDeliverySetting("next-turn");

		assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), {
			...legacy,
			stateful: { ...legacy.stateful, completionDelivery: "next-turn" },
		});
		assert.deepEqual(JSON.parse(readFileSync(legacyPath, "utf8")), legacy);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("legacy-seeded updates preserve canonical settings created before publication", () => {
	const updates = [
		["completion delivery", () => updateCompletionDeliverySetting("next-turn")],
		["delegation workflow", () => updateDelegationWorkflowSetting("async-only")],
		["blocking parallel limit", () => updateBlockingMaxParallelTasksSetting(4)],
		["detached limit", () => updateStatefulLimitSetting("maxAgents", 4)],
		["agent tools", () => updateAgentToolsSetting("scout", ["read"])],
	] as const;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const [name, update] of updates) {
			const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-legacy-race-"));
			process.env.PI_CODING_AGENT_DIR = directory;
			try {
				const legacyPath = path.join(directory, "pi-subagents-config.json");
				const canonicalPath = path.join(directory, "pi-subagents.json");
				const legacy = { stateful: { completionDelivery: "auto-resume" }, legacyOnly: true };
				const concurrent = { stateful: { completionDelivery: "auto-resume" }, concurrent: true };
				writeFileSync(legacyPath, JSON.stringify(legacy));

				const originalWriteFileSync = fs.writeFileSync;
				let createCanonical = true;
				fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
					const result = originalWriteFileSync(...args);
					const writtenPath = path.resolve(String(args[0]));
					if (
						createCanonical &&
						path.dirname(writtenPath) === path.resolve(directory) &&
						path.basename(writtenPath).startsWith(".pi-subagents.json.")
					) {
						createCanonical = false;
						originalWriteFileSync(canonicalPath, JSON.stringify(concurrent));
					}
					return result;
				}) as typeof fs.writeFileSync;
				syncBuiltinESMExports();
				try {
					assert.throws(
						update,
						/created concurrently.*reopen settings and retry/i,
						`${name} should reject the raced-in canonical file`,
					);
				} finally {
					fs.writeFileSync = originalWriteFileSync;
					syncBuiltinESMExports();
				}

				assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), concurrent);
				assert.deepEqual(JSON.parse(readFileSync(legacyPath, "utf8")), legacy);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("delegation workflow inspection and updates preserve unknown settings", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflow-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		assert.deepEqual(inspectDelegationWorkflowSettings(), {
			path: path.join(directory, "pi-subagents.json"),
			value: "all",
			source: "default",
		});
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				future: true,
				blocking: { futureBlocking: 1 },
				stateful: { futureStateful: 2 },
			}),
		);
		updateDelegationWorkflowSetting("async-only");
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			blocking: { futureBlocking: 1, enabled: false },
			stateful: { futureStateful: 2, enabled: true },
		});
		assert.deepEqual(inspectDelegationWorkflowSettings(), {
			path: settingsPath,
			value: "async-only",
			source: "user settings",
		});
		updateDelegationWorkflowSetting("blocking-only");
		assert.equal(inspectDelegationWorkflowSettings().value, "blocking-only");
		updateDelegationWorkflowSetting("all");
		assert.equal(inspectDelegationWorkflowSettings().value, "all");
		writeFileSync(settingsPath, "invalid");
		const malformed = inspectDelegationWorkflowSettings();
		assert.equal(malformed.value, "all");
		assert.match(malformed.error ?? "", /Unexpected token|JSON/i);
		assert.throws(() => updateDelegationWorkflowSetting("async-only"), /Cannot update malformed/);
		assert.equal(readFileSync(settingsPath, "utf8"), "invalid");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("completion delivery inspection rejects malformed settings without overwriting them", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-completion-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		assert.deepEqual(inspectCompletionDeliverySettings(), {
			path: path.join(directory, "pi-subagents.json"),
			value: "next-turn",
			source: "default",
		});
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{ malformed");
		assert.match(inspectCompletionDeliverySettings().error ?? "", /JSON|position|property/i);
		assert.throws(() => updateCompletionDeliverySetting("auto-resume"), /Cannot update malformed/);
		assert.equal(readFileSync(settingsPath, "utf8"), "{ malformed");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("agent tool patches preserve prototype-like names as data", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-tools-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		updateAgentToolsSetting("__proto__", ["read"]);
		const raw = JSON.parse(readFileSync(path.join(directory, "pi-subagents.json"), "utf8"));
		assert.equal(Object.hasOwn(raw.agents, "__proto__"), true);
		assert.deepEqual(Object.getOwnPropertyDescriptor(raw.agents, "__proto__")?.value, {
			tools: ["read"],
		});
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent formatting and set helpers are deterministic", () => {
	assert.equal(parsePositiveInteger("42ms"), 42);
	assert.equal(parsePositiveInteger("0"), undefined);
	assert.equal(formatTokens(1530), "1.5k");
	assert.equal(
		formatUsageStats(
			{ input: 1500, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0123, turns: 2 },
			"gpt",
		),
		"2 turns ↑1.5k ↓20 $0.0123 gpt",
	);
	assert.equal(
		formatUsageStats(
			{ input: 1500, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0123, turns: 2 },
			"gpt",
			"high",
		),
		"2 turns ↑1.5k ↓20 $0.0123 gpt requested-thinking:high",
	);
	assert.equal(
		formatUsageStats(
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			"requested-alias",
			"high",
			"actual-provider",
			"actual-model",
		),
		"actual-provider/actual-model requested-thinking:high",
	);
	assert.deepEqual(uniqueToolNames(["read", "read", "bash"]), ["read", "bash"]);
	assert.equal(sameToolSet(["read", "bash"], ["bash", "read"]), true);
});

test("subagent thinking levels resolve by local, top-level, then agent default", () => {
	const agents = [{ name: "scout", thinkingLevel: "low" }, { name: "reviewer" }] as const;

	assert.equal(resolveSubagentThinkingLevel(agents, "scout", "medium", "high"), "high");
	assert.equal(resolveSubagentThinkingLevel(agents, "scout", "medium"), "medium");
	assert.equal(resolveSubagentThinkingLevel(agents, "scout"), "low");
	assert.equal(resolveSubagentThinkingLevel(agents, "reviewer"), undefined);
	assert.equal(resolveSubagentThinkingLevel(agents, "missing", "minimal"), "minimal");
});

test("buildPiArgs passes thinking only when requested", () => {
	assert.deepEqual(buildPiArgs({ task: "do it" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"Task: do it",
	]);
	assert.deepEqual(
		buildPiArgs({
			model: "sonnet",
			thinkingLevel: "high",
			tools: ["read", "bash"],
			systemPromptPath: "/tmp/prompt.md",
			task: "review code",
		}),
		[
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"sonnet",
			"--thinking",
			"high",
			"--tools",
			"read,bash",
			"--append-system-prompt",
			"/tmp/prompt.md",
			"Task: review code",
		],
	);
	assert.deepEqual(buildPiArgs({ thinkingLevel: "off", tools: [], task: "no tools" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--thinking",
		"off",
		"--no-tools",
		"Task: no tools",
	]);
});

test("aggregator usability requires non-whitespace agent and task values", () => {
	assert.equal(hasUsableAggregator(undefined), false);
	assert.equal(hasUsableAggregator({ agent: "", task: "Synthesize" }), false);
	assert.equal(hasUsableAggregator({ agent: "reviewer", task: " \t" }), false);
	assert.equal(hasUsableAggregator({ agent: "reviewer", task: "Synthesize" }), true);
});

test("blocking delegation preflights every target and passes explicit saved trust", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-blocking-cwd-"));
	const agentDir = path.join(root, "agent-home");
	const workspace = path.join(root, "workspace");
	const external = path.join(root, "external");
	const marker = path.join(root, "launched");
	const fakePi = path.join(root, "fake-pi.mjs");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	mkdirSync(external);
	writeFileSync(
		fakePi,
		[
			"import{writeFileSync}from'node:fs';",
			`writeFileSync(${JSON.stringify(marker)},'yes');`,
			"const text=process.argv.slice(2).join(' ');",
			"const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const restorePiPackage = useFakePiPackage(root, fakePi);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const tool = mock.tools.find((candidate) => candidate.name === "subagent") as SubagentTool;
		const ctx = createMockContext({ cwd: workspace, isProjectTrusted: () => true }).ctx;
		for (const params of [
			{ agent: "scout", task: "single", cwd: external },
			{
				chain: [
					{ agent: "scout", task: "first", cwd: workspace },
					{ agent: "scout", task: "second", cwd: external },
				],
			},
			{
				tasks: [
					{ agent: "scout", task: "first", cwd: workspace },
					{ agent: "scout", task: "second", cwd: external },
				],
			},
			{
				tasks: [{ agent: "scout", task: "first", cwd: workspace }],
				aggregator: { agent: "scout", task: "fan-in", cwd: external },
			},
		] as Array<Record<string, unknown>>) {
			await assert.rejects(
				() => tool.execute("cwd-policy", params, undefined, undefined, ctx),
				/saved-trusted.*\/trust/i,
			);
			assert.equal(existsSync(marker), false);
		}

		new ProjectTrustStore(agentDir).set(external, true);
		const accepted = await tool.execute(
			"cwd-trusted",
			{ agent: "scout", task: "trusted", cwd: external },
			undefined,
			undefined,
			ctx,
		);
		assert.match(accepted.content?.[0]?.text ?? "", /--approve/);
		assert.equal(accepted.details?.results[0]?.target?.trust.kind, "saved-trusted");
		assert.equal(accepted.details?.results[0]?.target?.cwd, external);

		rmSync(marker, { force: true });
		writeFileSync(
			path.join(agentDir, "pi-subagents.json"),
			JSON.stringify({ cwdPolicy: { delegation: "anywhere" } }),
		);
		const anywhereMock = createMockPi();
		subagents(anywhereMock.pi);
		const anywhereTool = anywhereMock.tools.find(
			(candidate) => candidate.name === "subagent",
		) as SubagentTool;
		new ProjectTrustStore(agentDir).set(external, false);
		const anywhere = await anywhereTool.execute(
			"cwd-anywhere",
			{ agent: "scout", task: "anywhere", cwd: external },
			undefined,
			undefined,
			ctx,
		);
		assert.match(anywhere.content?.[0]?.text ?? "", /--no-approve/);
		assert.equal(anywhere.details?.results[0]?.target?.trust.kind, "saved-denied");
	} finally {
		restorePiPackage();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("parallel execution ignores an empty optional aggregator and preserves worker outputs", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const { ctx } = createMockContext();
	const signal = new AbortController().signal;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-empty-aggregator-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		[
			"const task=process.argv.at(-1) ?? '';",
			"const output=task.includes('PROOF')?'PROOF_OK':'CALC_OK';",
			"const message={role:'assistant',content:[{type:'text',text:output}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	const restorePiPackage = useFakePiPackage(dir, fakePi);
	try {
		const result = await tool.execute(
			"empty-aggregator",
			{
				tasks: [
					{ agent: "scout", task: "PROOF" },
					{ agent: "scout", task: "CALC" },
				],
				aggregator: { agent: " ", task: "\t", thinkingLevel: "off", timeoutMs: 1 },
			},
			signal,
			() => undefined,
			ctx,
		);
		assert.equal(result.isError, undefined);
		assert.equal(result.details?.aggregator, undefined);
		assert.match(result.content?.[0]?.text ?? "", /Parallel: 2\/2 succeeded/);
		assert.match(result.content?.[0]?.text ?? "", /PROOF_OK/);
		assert.match(result.content?.[0]?.text ?? "", /CALC_OK/);
	} finally {
		restorePiPackage();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("subagent execute resolves thinking level in single, chain, parallel, and aggregator modes", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const { ctx } = createMockContext();
	const signal = new AbortController().signal;

	const single = await tool.execute(
		"single",
		{ agent: "missing", task: "single", thinkingLevel: "medium" },
		signal,
		() => undefined,
		ctx,
	);
	assert.equal(single.details?.results[0]?.thinkingLevel, "medium");

	const chain = await tool.execute(
		"chain",
		{
			thinkingLevel: "low",
			chain: [{ agent: "missing", task: "chain", thinkingLevel: "high" }],
		},
		signal,
		() => undefined,
		ctx,
	);
	assert.equal(chain.details?.results[0]?.thinkingLevel, "high");

	const parallel = await tool.execute(
		"parallel",
		{
			thinkingLevel: "minimal",
			tasks: [
				{ agent: "missing", task: "inherits top level" },
				{ agent: "missing", task: "local override", thinkingLevel: "off" },
			],
			aggregator: { agent: "missing", task: "aggregate", thinkingLevel: "xhigh" },
		},
		signal,
		() => undefined,
		ctx,
	);
	assert.equal(parallel.details?.results[0]?.thinkingLevel, "minimal");
	assert.equal(parallel.details?.results[1]?.thinkingLevel, "off");
	assert.equal(parallel.details?.aggregator?.thinkingLevel, "xhigh");
});

test("parallel updates keep failed fan-out pending while fan-in starts", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const { ctx } = createMockContext();
	const signal = new AbortController().signal;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pending-fan-in-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		[
			"const task=process.argv.at(-1) ?? '';",
			"const failed=task.includes('RUN_FANOUT_FAILURE')&&!task.includes('RUN_AGGREGATOR');",
			"const message=failed",
			"? {role:'assistant',content:[{type:'text',text:'FANOUT_PARTIAL'}],stopReason:'error',errorMessage:'FANOUT_FAILED',timestamp:Date.now()}",
			": {role:'assistant',content:[{type:'text',text:'FAN_IN_COMPLETE'}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	const updates: Array<{
		details?: {
			results: Array<{ stopReason?: string }>;
			aggregator?: { exitCode: number };
		};
	}> = [];
	const restorePiPackage = useFakePiPackage(dir, fakePi);
	try {
		const result = await tool.execute(
			"pending-fan-in",
			{
				tasks: [{ agent: "scout", task: "RUN_FANOUT_FAILURE" }],
				aggregator: { agent: "scout", task: "RUN_AGGREGATOR" },
			},
			signal,
			(update: unknown) => updates.push(update as (typeof updates)[number]),
			ctx,
		);
		assert.match(result.content?.[0]?.text ?? "", /FAN_IN_COMPLETE/);
		assert.ok(
			updates.some(
				(update) =>
					update.details?.results[0]?.stopReason === "error" &&
					update.details.aggregator?.exitCode === -1,
			),
			"expected a failed fan-out update with a pending fan-in result",
		);
	} finally {
		restorePiPackage();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parallel summaries classify provider errors and retain partial output", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const { ctx } = createMockContext();
	const signal = new AbortController().signal;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-error-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		[
			"const task=process.argv.at(-1) ?? '';",
			"const failed=task.includes('provider failure');",
			"const message=failed",
			"? {role:'assistant',content:[{type:'text',text:'PARTIAL'}],stopReason:'error',errorMessage:'PROVIDER_FAILED',timestamp:Date.now()}",
			": {role:'assistant',content:[{type:'text',text:'DONE'}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	const restorePiPackage = useFakePiPackage(dir, fakePi);
	try {
		const result = await tool.execute(
			"parallel-errors",
			{
				tasks: [
					{ agent: "scout", task: "provider failure" },
					{ agent: "scout", task: "success" },
				],
			},
			signal,
			() => undefined,
			ctx,
		);
		const text = result.content?.[0]?.text ?? "";
		assert.match(text, /Parallel: 1\/2 succeeded/);
		assert.match(text, /\[scout\] failed: PROVIDER_FAILED/);
		assert.match(text, /Partial output:\nPARTIAL/);
		assert.match(text, /\[scout\] completed: DONE/);
	} finally {
		restorePiPackage();
		rmSync(dir, { recursive: true, force: true });
	}
});
