import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { AgentPersistence } from "../src/persistence.js";
import { AgentRegistry, type ManagedAgent } from "../src/registry.js";
import { normalizeSubagentSettings } from "../src/settings.js";
import {
	assertFollowUpWriteAllowed,
	formatStatefulAgentLine,
	isWriteCapable,
	registerStatefulSubagents,
	resolveCompletionDelivery,
	resolveSpawnContextMode,
	resolveStatefulTransportKind,
} from "../src/stateful.js";
import { resolveStatefulLimits } from "../src/stateful-limits.js";
import {
	resolveStatefulSubprocessThinkingLevel,
	SubprocessTransport,
} from "../src/subprocess-transport.js";
import { WorkspaceManager } from "../src/workspace.js";

function record(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
	return {
		id: "sa_test",
		agent: "scout",
		rootId: "sa_test",
		depth: 0,
		children: [],
		state: "completed",
		createdAt: 1,
		updatedAt: Date.now(),
		cwd: process.cwd(),
		history: [],
		mailbox: [],
		...overrides,
	};
}

test("WorkspaceManager creates and cleans owned disposable worktrees", async () => {
	const repo = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-repo-"));
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
	writeFileSync(path.join(repo, "tracked.txt"), "base\n");
	mkdirSync(path.join(repo, "nested"));
	writeFileSync(path.join(repo, "nested", "inner.txt"), "inner\n");
	execFileSync("git", ["-C", repo, "add", "tracked.txt", "nested/inner.txt"]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
	const manager = new WorkspaceManager();
	const workspace = await manager.create("owner", path.join(repo, "nested"));
	assert.equal(readFileSync(path.join(workspace.path, "inner.txt"), "utf8"), "inner\n");
	assert.equal(readFileSync(path.join(workspace.rootPath, "tracked.txt"), "utf8"), "base\n");
	await assert.rejects(() => manager.create("owner", repo), /owner already exists/);
	rmSync(`${workspace.rootPath}.owner`);
	await assert.rejects(() => manager.cleanup("owner"), /Refusing to clean unowned/);
	writeFileSync(`${workspace.rootPath}.owner`, "owner", { mode: 0o600 });
	await manager.cleanup("owner");
	assert.equal(existsSync(workspace.rootPath), false);
	const second = await manager.create("second", repo);
	await manager.cleanupAll();
	assert.equal(existsSync(second.path), false);
	writeFileSync(path.join(repo, "dirty.txt"), "dirty");
	await assert.rejects(() => manager.create("dirty", repo), /clean Git repository/);
});

test("shared-workspace write classification and follow-up guards are conservative", async () => {
	assert.equal(isWriteCapable(undefined), true);
	assert.equal(isWriteCapable(["read", "grep"]), false);
	assert.equal(isWriteCapable(["read", "bash"]), true);
	assert.equal(isWriteCapable(["edit"]), true);
	const registry = new AgentRegistry(async (_agent, _task, signal) => {
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		return { output: "interrupted", exitCode: 130, aborted: true };
	});
	const active = await registry.spawn({ agent: "worker", task: "active", cwd: process.cwd() });
	const followUp = record({ agent: "worker", cwd: process.cwd(), state: "completed" });
	assert.throws(
		() => assertFollowUpWriteAllowed(registry, followUp, false, false),
		(error: unknown) => {
			assert.match(String(error), /already active in shared workspace/);
			assert.match(String(error), /prefer one subagent_spawn.*asynchronous work/i);
			assert.match(String(error), /blocking subagent parallel mode.*synchronous outputs/i);
			assert.doesNotMatch(
				String(error),
				/For independent one-shot work, use subagent parallel mode/,
			);
			assert.match(String(error), /let the active agent finish or close/);
			assert.match(String(error), /allowConcurrentWrites/);
			assert.match(String(error), /worktree/);
			return true;
		},
	);
	assert.doesNotThrow(() => assertFollowUpWriteAllowed(registry, followUp, true, false));
	assert.doesNotThrow(() => assertFollowUpWriteAllowed(registry, followUp, false, true));
	await registry.interrupt(active.id);
});

test("stateful agent lines escape terminal controls from retained agent data", () => {
	const line = formatStatefulAgentLine(
		record({
			agent: "scout\u001b]8;;https://example.com\u0007linked",
			currentTask: "first line\nsecond line\u009b31m",
		}),
	);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Verify terminal-control escaping.
	assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/u);
	assert.match(line, /scout.*linked/);
	assert.match(line, /first line second line/);
});

test("selected context entries imply all mode only when context mode is omitted", () => {
	assert.equal(resolveSpawnContextMode(undefined, ["entry"]), "all");
	assert.equal(resolveSpawnContextMode(undefined, []), "all");
	assert.equal(resolveSpawnContextMode(undefined, undefined), "none");
	assert.equal(resolveSpawnContextMode("none", ["entry"]), "none");
	assert.equal(resolveSpawnContextMode(3, ["entry"]), 3);
});

test("stateful tools are available by default, disable cleanly, and expose the lifecycle surface", async () => {
	const originalDir = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-config-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const mock = createMockPi({ activeTools: ["read"] });
		const controller = registerStatefulSubagents(mock.pi);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			limits: resolveStatefulLimits(),
			activeAgents: 0,
			retainedAgents: 0,
		});
		assert.deepEqual(controller.listAgents(), []);
		assert.equal(await controller.clearAgents(), 0);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			["subagent_spawn", "subagent_send", "subagent_manage", "subagent_mailbox"],
		);
		assert.equal(
			mock.tools.some((tool) =>
				[
					"subagent_message",
					"subagent_messages",
					"subagent_list",
					"subagent_interrupt",
					"subagent_close",
				].includes(String(tool.name)),
			),
			false,
		);
		assert.equal(mock.commands.has("subagents:agents"), false);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: true,
			transport: "subprocess",
			completionDelivery: "next-turn",
			limits: resolveStatefulLimits(),
			activeAgents: 0,
			retainedAgents: 0,
		});
		const spawn = mock.tools.find((tool) => tool.name === "subagent_spawn") as unknown as {
			name: string;
			description: string;
			promptGuidelines: string[];
		};
		controller.setAgentCatalog(
			'Available agent definitions\n- api-reviewer [source: user; agentScope: "user"] — Reviews APIs',
		);
		const catalogRegistration = mock.tools
			.filter((tool) => tool.name === "subagent_spawn")
			.at(-1) as typeof spawn | undefined;
		assert.match(catalogRegistration?.description ?? "", /api-reviewer/);
		controller.setCompletionDelivery("auto-resume");
		const autoResumeRegistration = mock.tools
			.filter((tool) => tool.name === "subagent_spawn")
			.at(-1) as typeof spawn | undefined;
		assert.match(autoResumeRegistration?.description ?? "", /api-reviewer/);
		assert.match(autoResumeRegistration?.promptGuidelines?.join("\n") ?? "", /auto-resume/);
		controller.setAgentCatalog("Available agent definitions\n- worker [source: built-in]");
		const refreshedRegistration = mock.tools
			.filter((tool) => tool.name === "subagent_spawn")
			.at(-1) as typeof spawn | undefined;
		assert.match(refreshedRegistration?.description ?? "", /worker/);
		assert.doesNotMatch(refreshedRegistration?.description ?? "", /api-reviewer/);
		assert.match(refreshedRegistration?.promptGuidelines?.join("\n") ?? "", /auto-resume/);
		controller.setCompletionDelivery("next-turn");
		assert.equal(spawn.name, "subagent_spawn");

		const send = mock.tools.find((tool) => tool.name === "subagent_send") as {
			description: string;
			promptSnippet?: string;
		};
		const manage = mock.tools.find((tool) => tool.name === "subagent_manage") as {
			description: string;
			parameters: { properties?: Record<string, { description?: string; enum?: string[] }> };
			execute: (...args: unknown[]) => Promise<{
				content: Array<{ text: string }>;
				details: Record<string, unknown>;
			}>;
		};
		const mailbox = mock.tools.find((tool) => tool.name === "subagent_mailbox") as {
			description: string;
			parameters: {
				required?: string[];
				properties?: Record<
					string,
					{
						description?: string;
						enum?: string[];
						maximum?: number;
						maxLength?: number;
						minimum?: number;
					}
				>;
			};
			execute: (...args: unknown[]) => Promise<unknown>;
		};
		assert.match(send.description, /follow-up.*start.*turn/i);
		assert.match(send.description, /subagent_mailbox.*queue-only/i);
		assert.match(manage.description, /list.*interrupt.*close/i);
		assert.deepEqual(manage.parameters.properties?.action?.enum, ["list", "interrupt", "close"]);
		assert.match(
			manage.parameters.properties?.action?.description ?? "",
			/list.*interrupt.*close/i,
		);
		assert.match(mailbox.description, /without starting a turn.*read/i);
		assert.deepEqual(mailbox.parameters.properties?.action?.enum, ["send", "read"]);
		assert.match(mailbox.parameters.properties?.action?.description ?? "", /send.*read/i);
		assert.deepEqual(mailbox.parameters.required?.sort(), ["action", "agentId"]);
		assert.equal(mailbox.parameters.properties?.message?.maxLength, 16 * 1024);
		assert.equal(mailbox.parameters.properties?.limit?.minimum, 1);
		assert.equal(mailbox.parameters.properties?.limit?.maximum, 20);
		const listed = await manage.execute(
			"id",
			{ action: "list" },
			undefined,
			undefined,
			context.ctx,
		);
		assert.equal(listed.content[0].text, "No stateful subagents.");
		assert.deepEqual(listed.details, { agents: [] });
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
		await assert.rejects(
			() => manage.execute("id", { action: "interrupt" }, undefined, undefined, context.ctx),
			/subagent_manage action "interrupt" requires agentId/,
		);
		const listedWithProviderDefaults = await manage.execute(
			"id",
			{
				action: "list",
				agentId: "sa_unused",
				includeClosed: false,
				subtree: false,
			},
			undefined,
			undefined,
			context.ctx,
		);
		assert.equal(listedWithProviderDefaults.content[0].text, "No stateful subagents.");
		await assert.rejects(
			() =>
				manage.execute(
					"id",
					{ action: "list", unexpected: true },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_manage does not accept unexpected/,
		);
		await assert.rejects(
			() => manage.execute("id", { action: 1 }, undefined, undefined, context.ctx),
			/subagent_manage action must be one of/,
		);
		await assert.rejects(
			() =>
				manage.execute(
					"id",
					{ action: "list", includeClosed: "yes" },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_manage action "list" requires includeClosed to be a boolean/,
		);
		await assert.rejects(
			() =>
				manage.execute(
					"id",
					{
						action: "interrupt",
						agentId: "sa_unknown",
						includeClosed: false,
						subtree: false,
					},
					undefined,
					undefined,
					context.ctx,
				),
			/Unknown subagent/,
		);
		await assert.rejects(
			() =>
				manage.execute("id", { action: "close", agentId: 1 }, undefined, undefined, context.ctx),
			/subagent_manage action "close" requires agentId to be a non-empty string/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "send", agentId: "sa_unknown" },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox action "send" requires message/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{
						action: "read",
						agentId: "sa_unknown",
						message: "provider default",
						senderId: "provider default",
						deduplicationKey: "provider-default",
						acknowledge: true,
						limit: 20,
					},
					undefined,
					undefined,
					context.ctx,
				),
			/Unknown subagent/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "read", agentId: "sa_unknown", unexpected: true },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox does not accept unexpected/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{
						action: "send",
						agentId: "sa_unknown",
						message: "ok",
						acknowledge: true,
						limit: 20,
					},
					undefined,
					undefined,
					context.ctx,
				),
			/Unknown subagent/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "send", agentId: "sa_unknown", message: "x".repeat(16 * 1024 + 1) },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox action "send" requires message at most 16384 characters/,
		);
		await assert.rejects(
			() => mailbox.execute("id", { action: "archive" }, undefined, undefined, context.ctx),
			/subagent_mailbox action must be one of/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "read", agentId: "sa_unknown", acknowledge: "yes" },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox action "read" requires acknowledge to be a boolean/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "read", agentId: "sa_unknown", limit: 21 },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox action "read" requires limit between 1 and 20/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "read", agentId: "sa_unknown" },
					undefined,
					undefined,
					context.ctx,
				),
			/Unknown subagent/,
		);

		const project = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-project-"));
		const projectAgents = path.join(project, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(
			path.join(projectAgents, "project.md"),
			"---\nname: project\ndescription: project agent\n---\nDo project work.",
		);
		new ProjectTrustStore(dir).set(project, true);
		const untrusted = createMockContext({ cwd: project, isProjectTrusted: () => false });
		const spawnTool = mock.tools.find((tool) => tool.name === "subagent_spawn") as {
			description: string;
			execute: (...args: unknown[]) => Promise<unknown>;
			parameters: {
				properties?: Record<string, { description?: string; enum?: string[] }>;
			};
			promptGuidelines: string[];
		};
		const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		assert.deepEqual(spawnTool.parameters.properties?.thinkingLevel?.enum, thinkingLevels);
		assert.match(
			spawnTool.parameters.properties?.thinkingLevel?.description ?? "",
			/task difficulty/i,
		);
		assert.match(spawnTool.description, /thinking level.*task difficulty/i);
		const spawnGuidance = spawnTool.promptGuidelines.join("\n");
		assert.match(spawnGuidance, /simple or critical-path work/);
		assert.match(spawnGuidance, /prefer one subagent_spawn.*broad.*research/i);
		assert.match(spawnGuidance, /next-turn.*default/i);
		assert.match(spawnGuidance, /current response.*does not depend/i);
		assert.match(spawnGuidance, /blocking subagent.*final answer.*depends/i);
		assert.doesNotMatch(spawnGuidance, /even when.*final answer.*depends/i);
		assert.match(spawnGuidance, /do not.*blocking parallel.*same turn/i);
		assert.match(spawnGuidance, /single subagent_spawn.*isolation or specialization/i);
		assert.doesNotMatch(
			spawnGuidance,
			/use one blocking subagent parallel call for multiple independent one-shot tasks/i,
		);
		assert.match(spawnGuidance, /useful non-overlapping.*immediately/i);
		assert.match(spawnGuidance, /tell the user.*end the response/i);
		assert.match(spawnGuidance, /do not poll.*subagent_manage.*action.*list/i);
		assert.match(spawnGuidance, /subagent_mailbox.*action.*read/i);
		assert.doesNotMatch(spawnGuidance, /subagent_(?:list|messages)/i);
		assert.match(spawnGuidance, /synthesize available.*completion/i);
		assert.match(spawnGuidance, /subagent_spawn.*lowest sufficient.*thinking level/i);
		assert.match(spawnGuidance, /off.*minimal.*extraction.*mechanical/i);
		assert.match(spawnGuidance, /low.*straightforward.*bounded/i);
		assert.match(spawnGuidance, /medium.*multi-step/i);
		assert.match(spawnGuidance, /high.*debugging.*design.*review/i);
		assert.match(spawnGuidance, /xhigh.*ambiguous.*cross-system.*high-risk/i);
		assert.match(spawnGuidance, /max.*hardest.*quality.*latency.*cost/i);
		for (const guideline of spawnTool.promptGuidelines) {
			assert.match(
				guideline,
				/subagent_spawn/,
				`flattened spawn guideline must identify subagent_spawn: ${guideline}`,
			);
		}
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "1";
		try {
			await assert.rejects(
				() =>
					spawnTool.execute(
						"id",
						{ agent: "scout", task: "nested" },
						undefined,
						undefined,
						context.ctx,
					),
				/recursion depth limit/,
			);
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
		}
		await assert.rejects(
			() =>
				spawnTool.execute(
					"id",
					{
						agent: "project",
						task: "task",
						cwd: project,
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					createMockContext({ isProjectTrusted: () => true }).ctx,
				),
			/overridden cwd/,
		);
		await assert.rejects(
			() =>
				spawnTool.execute(
					"id",
					{
						agent: "project",
						task: "task",
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					untrusted.ctx,
				),
			/trusted project/,
		);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			limits: resolveStatefulLimits(),
			activeAgents: 0,
			retainedAgents: 0,
		});

		writeFileSync(
			path.join(dir, "pi-subagents.json"),
			JSON.stringify({ stateful: { completionDelivery: "auto-resume" } }),
		);
		const autoResume = createMockPi();
		registerStatefulSubagents(autoResume.pi);
		const autoResumeSpawn = autoResume.tools.find((tool) => tool.name === "subagent_spawn");
		assert.ok(Array.isArray(autoResumeSpawn?.promptGuidelines));
		const autoResumeGuidance = autoResumeSpawn.promptGuidelines.join("\n");
		assert.match(autoResumeGuidance, /auto-resume/i);
		assert.match(autoResumeGuidance, /even when.*final answer.*depends/i);
		assert.doesNotMatch(autoResumeGuidance, /next-turn.*default/i);

		writeFileSync(
			path.join(dir, "pi-subagents.json"),
			JSON.stringify({ stateful: { enabled: false } }),
		);
		const disabled = createMockPi();
		const disabledController = registerStatefulSubagents(disabled.pi);
		assert.equal(disabled.tools.length, 0);
		assert.equal(disabled.events.size, 0);
		assert.deepEqual(disabledController.getRuntimeStatus(), {
			enabled: false,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			limits: resolveStatefulLimits(),
			activeAgents: 0,
			retainedAgents: 0,
		});
		assert.deepEqual(disabledController.listAgents(), []);
		assert.equal(await disabledController.clearAgents(), 0);
		await assert.rejects(
			() => disabledController.queueMessage("missing", "message"),
			/not initialized/i,
		);
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	}
});

test("stateful spawn enforces trusted targets and carries trust into in-process children", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-stateful-cwd-"));
	const agentDir = path.join(root, "agent-home");
	const workspace = path.join(root, "workspace");
	const external = path.join(root, "external");
	const generated = path.join(root, "generated-worktree");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	mkdirSync(external);
	mkdirSync(generated);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let delegation: "trusted-targets" | "anywhere" = "trusted-targets";
	const created: ManagedAgent[] = [];
	const createdTools: Array<string[] | undefined> = [];
	try {
		const mock = createMockPi();
		const controller = registerStatefulSubagents(mock.pi, {
			settings: { transport: "in-process" },
			getSettings: () => ({
				cwdPolicy: { delegation },
				agents: { scout: { tools: [] } },
			}),
			workspaceManager: {
				async create() {
					return {
						mode: "worktree" as const,
						path: generated,
						rootPath: generated,
						repositoryRoot: workspace,
					};
				},
				async cleanup() {},
				async cleanupAll() {},
			} as unknown as WorkspaceManager,
			createInProcessSession: async (options) => {
				created.push(structuredClone(options.agent));
				createdTools.push(options.agentConfig.tools);
				const messages: unknown[] = [];
				return {
					sessionId: `child-${created.length}`,
					messages,
					async prompt() {
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							stopReason: "stop",
						});
					},
					subscribe: () => () => undefined,
					abort: async () => undefined,
					dispose: () => undefined,
					getActiveToolNames: () => ["read", "grep", "find", "ls", "bash"],
				};
			},
		});
		const context = createMockContext({ cwd: workspace, isProjectTrusted: () => true });
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		const spawn = mock.tools.find((tool) => tool.name === "subagent_spawn") as
			| { execute: (...args: unknown[]) => Promise<unknown> }
			| undefined;
		assert.ok(spawn);
		await assert.rejects(
			() =>
				spawn.execute(
					"unsaved",
					{ agent: "scout", task: "inspect", cwd: external },
					undefined,
					undefined,
					context.ctx,
				),
			/saved-trusted.*\/trust/i,
		);
		assert.deepEqual(controller.listAgents(), []);

		new ProjectTrustStore(agentDir).set(external, true);
		await spawn.execute(
			"trusted",
			{ agent: "scout", task: "inspect", cwd: external },
			undefined,
			undefined,
			context.ctx,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(createdTools[0], []);
		assert.equal(created[0]?.target?.trust.kind, "saved-trusted");
		assert.equal(created[0]?.target?.trust.projectTrusted, true);
		assert.equal(controller.listAgents()[0]?.target?.cwd, external);

		new ProjectTrustStore(agentDir).set(external, false);
		delegation = "anywhere";
		await spawn.execute(
			"anywhere",
			{ agent: "scout", task: "inspect", cwd: external },
			undefined,
			undefined,
			context.ctx,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(created[1]?.target?.trust.kind, "saved-denied");
		assert.equal(created[1]?.target?.trust.projectTrusted, false);

		await spawn.execute(
			"worktree",
			{ agent: "scout", task: "inspect", workspaceMode: "worktree" },
			undefined,
			undefined,
			context.ctx,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(created[2]?.cwd, generated);
		assert.equal(created[2]?.workspaceMode, "worktree");
		assert.equal(created[2]?.target?.cwd, workspace);
		assert.equal(created[2]?.target?.boundary, "current-workspace");
		assert.equal(created[2]?.target?.trust.kind, "session-trusted");
		assert.equal(created[2]?.target?.trust.projectTrusted, true);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("stateful restore re-resolves target trust instead of trusting persisted snapshots", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-restore-trust-"));
	const agentDir = path.join(root, "agent-home");
	const workspace = path.join(root, "workspace");
	const external = path.join(root, "external");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	mkdirSync(external);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await new AgentPersistence("test-session").save([
			record({
				id: "sa_restored",
				rootId: "sa_restored",
				cwd: external,
				updatedAt: Date.now(),
				target: {
					cwd: external,
					boundary: "external",
					trust: { kind: "saved-trusted", projectTrusted: true, sourcePath: external },
				},
			}),
			record({
				id: "sa_worktree",
				rootId: "sa_worktree",
				cwd: external,
				updatedAt: Date.now(),
				workspaceMode: "worktree",
			}),
		]);
		new ProjectTrustStore(agentDir).set(external, false);
		const mock = createMockPi();
		const controller = registerStatefulSubagents(mock.pi);
		const context = createMockContext({ cwd: workspace, isProjectTrusted: () => true });
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		const restoredAgents = controller.listAgents();
		assert.equal(restoredAgents.length, 1);
		const restored = restoredAgents[0];
		assert.equal(restored?.id, "sa_restored");
		assert.equal(restored?.target?.trust.kind, "saved-denied");
		assert.equal(restored?.target?.trust.projectTrusted, false);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("stateful worktree spawn revalidates session ownership and cleans stale work", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-stale-worktree-"));
	const agentDir = path.join(root, "agent-home");
	const workspace = path.join(root, "workspace");
	const generated = path.join(root, "generated");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	mkdirSync(generated);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let beginCreate: (() => void) | undefined;
	const createStarted = new Promise<void>((resolve) => {
		beginCreate = resolve;
	});
	let finishCreate:
		| ((value: {
				mode: "worktree";
				path: string;
				rootPath: string;
				repositoryRoot: string;
		  }) => void)
		| undefined;
	const created = new Promise<{
		mode: "worktree";
		path: string;
		rootPath: string;
		repositoryRoot: string;
	}>((resolve) => {
		finishCreate = resolve;
	});
	let cleaned = 0;
	let childCreates = 0;
	const workspaceManager = {
		async create() {
			beginCreate?.();
			return created;
		},
		async cleanup() {
			cleaned++;
		},
		async cleanupAll() {},
	} as unknown as WorkspaceManager;
	try {
		const mock = createMockPi();
		const controller = registerStatefulSubagents(mock.pi, {
			settings: { transport: "in-process" },
			workspaceManager,
			createInProcessSession: async () => {
				childCreates++;
				throw new Error("stale spawn must not create a child");
			},
		});
		const first = createMockContext({ cwd: workspace, isProjectTrusted: () => true });
		await mock.events.get("session_start")?.[0]?.({}, first.ctx);
		const spawn = mock.tools.find((tool) => tool.name === "subagent_spawn") as
			| { execute: (...args: unknown[]) => Promise<unknown> }
			| undefined;
		assert.ok(spawn);
		const pending = spawn.execute(
			"worktree",
			{ agent: "scout", task: "inspect", workspaceMode: "worktree" },
			undefined,
			undefined,
			first.ctx,
		);
		await createStarted;
		const replacement = createMockContext({ cwd: workspace, isProjectTrusted: () => true });
		await mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
		finishCreate?.({
			mode: "worktree",
			path: generated,
			rootPath: generated,
			repositoryRoot: workspace,
		});
		await assert.rejects(pending, (error) => error instanceof Error && error.name === "AbortError");
		assert.equal(cleaned, 1);
		assert.equal(childCreates, 0);
		assert.deepEqual(controller.listAgents(), []);
		await mock.events.get("session_shutdown")?.[0]?.({}, replacement.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("stateful clear and session replacement serialize active-child cleanup before the new runtime", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-runtime-replacement-"));
	const agentDir = path.join(root, "agent-home");
	const workspace = path.join(root, "workspace");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let childStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		childStarted = resolve;
	});
	let finishPrompt: (() => void) | undefined;
	let aborts = 0;
	let disposals = 0;
	try {
		const mock = createMockPi();
		const controller = registerStatefulSubagents(mock.pi, {
			settings: { transport: "in-process" },
			createInProcessSession: async () => {
				const messages: unknown[] = [];
				return {
					sessionId: "active-child",
					messages,
					prompt: async () => {
						childStarted?.();
						await new Promise<void>((resolve) => {
							finishPrompt = resolve;
						});
					},
					subscribe: () => () => undefined,
					abort: async () => {
						aborts++;
						finishPrompt?.();
					},
					dispose: () => {
						disposals++;
					},
					getActiveToolNames: () => ["read", "grep", "find", "ls", "bash"],
				};
			},
		});
		const first = createMockContext({ cwd: workspace, isProjectTrusted: () => true });
		await mock.events.get("session_start")?.[0]?.({}, first.ctx);
		const spawn = mock.tools.find((tool) => tool.name === "subagent_spawn") as
			| { execute: (...args: unknown[]) => Promise<unknown> }
			| undefined;
		assert.ok(spawn);
		await spawn.execute(
			"active",
			{ agent: "scout", task: "wait" },
			undefined,
			undefined,
			first.ctx,
		);
		await started;
		const replacement = createMockContext({
			cwd: workspace,
			isProjectTrusted: () => true,
			sessionManager: {
				getSessionId: () => "replacement-session",
				getSessionName: () => undefined,
				getBranch: () => [],
				getEntries: () => [],
			},
		});
		const clearing = controller.clearAgents();
		const replacing = mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
		await Promise.all([clearing, replacing]);
		assert.ok(aborts >= 1);
		assert.equal(disposals, 1);
		assert.deepEqual(controller.listAgents(), []);
		await mock.events.get("session_shutdown")?.[0]?.({}, replacement.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("stateful subprocess uses the retained resolved trust decision", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-stateful-subprocess-trust-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		[
			"const text=process.argv.slice(2).join(' ');",
			"const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			bin: { pi: path.basename(fakePi) },
		}),
	);
	const previousPackageDir = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = root;
	try {
		const transport = new SubprocessTransport({
			getSettings: () => ({ agents: { scout: { tools: [] } } }),
		});
		for (const [projectTrusted, expected] of [
			[true, "--approve"],
			[false, "--no-approve"],
		] as const) {
			const outcome = await transport.runTurn(
				record({
					cwd: root,
					target: {
						cwd: root,
						boundary: "external",
						trust: {
							kind: projectTrusted ? "saved-trusted" : "saved-denied",
							projectTrusted,
						},
					},
				}),
				"inspect",
				new AbortController().signal,
			);
			assert.equal(outcome.exitCode, 0);
			assert.match(outcome.output, new RegExp(expected));
			assert.match(outcome.output, /--no-tools/);
		}
	} finally {
		if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previousPackageDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("stateful subprocess thinking uses spawn override before the agent default", () => {
	const agents = [{ name: "scout", thinkingLevel: "low" as const }, { name: "reviewer" }];
	assert.equal(
		resolveStatefulSubprocessThinkingLevel(agents, record({ thinkingLevel: "high" })),
		"high",
	);
	assert.equal(resolveStatefulSubprocessThinkingLevel(agents, record()), "low");
	assert.equal(
		resolveStatefulSubprocessThinkingLevel(agents, record({ agent: "reviewer" })),
		undefined,
	);
});

test("stateful settings validate transport, completion delivery, and bounded runtime options", () => {
	assert.equal(resolveStatefulTransportKind(undefined), "subprocess");
	assert.equal(resolveStatefulTransportKind("in-process"), "in-process");
	assert.equal(resolveCompletionDelivery(undefined), "next-turn");
	assert.equal(resolveCompletionDelivery("auto-resume"), "auto-resume");
	assert.deepEqual(
		normalizeSubagentSettings({
			stateful: {
				enabled: true,
				transport: "in-process",
				completionDelivery: "auto-resume",
				maxAgents: 8,
				maxDepth: 2,
				maxChildrenPerAgent: 3,
				maxMailboxMessages: 10,
				maxMailboxMessageBytes: 4096,
			},
			agents: {},
		}),
		{
			stateful: {
				enabled: true,
				transport: "in-process",
				completionDelivery: "auto-resume",
				maxAgents: 8,
				maxDepth: 2,
				maxChildrenPerAgent: 3,
				maxMailboxMessages: 10,
				maxMailboxMessageBytes: 4096,
			},
		},
	);
	assert.deepEqual(normalizeSubagentSettings({ stateful: { transport: "subprocess" } }), {
		stateful: { transport: "subprocess" },
	});
	assert.equal(normalizeSubagentSettings({ stateful: { transport: "native" } }), undefined);
	assert.equal(
		normalizeSubagentSettings({ stateful: { completionDelivery: "always" } }),
		undefined,
	);
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 0 } }), undefined);
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 1.5 } }), undefined);
	assert.deepEqual(normalizeSubagentSettings({ stateful: { maxDepth: 0 } }), {
		stateful: { maxDepth: 0 },
	});
});
