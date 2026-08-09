import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { applyCapabilityCeiling, CapabilityCeilingRegistry } from "../src/capability-ceiling.js";
import { currentAgentDetailScreen } from "../src/current-agents-ui.js";
import { parseEvidenceAttestation } from "../src/evidence.js";
import { updateFleetWidget } from "../src/fleet-view.js";
import { resolveLaunchContract } from "../src/launch-contract.js";
import { LifecycleArtifactWriter } from "../src/lifecycle-artifacts.js";
import {
	PI_SUBAGENTS_V1_READY,
	PI_SUBAGENTS_V1_REPLY,
	PI_SUBAGENTS_V1_REQUEST,
	registerPiSubagentsV1Api,
} from "../src/public-api.js";
import type { ManagedAgent } from "../src/registry.js";

function managedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
	return {
		id: "sa_1",
		agent: "worker",
		rootId: "sa_1",
		depth: 0,
		children: [],
		state: "running",
		createdAt: 1,
		updatedAt: 2,
		cwd: "/workspace",
		currentTask: "inspect\u001b[31m safely",
		history: [],
		mailbox: [],
		...overrides,
	};
}

describe("additive pi-subagents capabilities", () => {
	test("the declared entrypoint registers seven tools while the API import is inert", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-subagents-loader-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = directory;
		try {
			const before = createMockPi();
			await import("../src/public-api.js");
			assert.equal(before.tools.length, 0);
			const loaded = createMockPi();
			const entrypoint = "../src/index.js";
			const extension = (await import(entrypoint)).default;
			extension(loaded.pi);
			assert.deepEqual(
				loaded.tools.map((tool) => tool.name),
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
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("capability ceilings intersect and never widen tools", () => {
		const registry = new CapabilityCeilingRegistry();
		registry.register("policy-a", {
			allowedAgents: ["worker", "scout"],
			allowedTools: ["read", "bash"],
		});
		registry.register("policy-b", {
			allowedAgents: ["worker"],
			allowedTools: ["read"],
			denyExtensions: true,
		});
		const ceiling = registry.resolve();
		assert.deepEqual(ceiling, {
			allowedAgents: ["worker"],
			allowedTools: ["read"],
			denyExtensions: true,
			sources: ["policy-a", "policy-b"],
		});
		assert.deepEqual(applyCapabilityCeiling("worker", ["read", "write"], ceiling), {
			tools: ["read"],
			disableExtensions: true,
		});
		assert.throws(() => applyCapabilityCeiling("scout", ["read"], ceiling), /denied/);
		assert.throws(
			() => registry.register("invalid", { denyExtensions: "yes" as unknown as boolean }),
			/boolean/,
		);
		const audited = new CapabilityCeilingRegistry();
		for (let index = 0; index < 40; index++) {
			const token = audited.register(`policy-${index}`, {});
			audited.dispose(token);
		}
		assert.equal(audited.audit().length, 64);
		assert.equal(audited.audit().at(-1)?.source, "policy-39");
		audited.clear();
		assert.deepEqual(audited.audit(), []);
	});

	test("launch contracts are stable and project only safe metadata", () => {
		const options = {
			agent: {
				name: "worker",
				description: "Worker",
				tools: ["read", "write"],
				systemPrompt: "secret prompt",
				source: "built-in" as const,
				filePath: "built-in:worker",
			},
			agentScope: "user" as const,
			target: {
				cwd: "/workspace",
				boundary: "current-workspace" as const,
				trust: { kind: "session-trusted" as const, projectTrusted: true },
			},
			timeoutMs: 1000,
			transport: "subprocess" as const,
			evidence: "attested" as const,
			ceiling: { allowedTools: ["read"], sources: ["parent"] },
		};
		const first = resolveLaunchContract(options);
		const second = resolveLaunchContract(options);
		assert.equal(first.digest, second.digest);
		assert.deepEqual(first.effectiveTools, ["read"]);
		assert.equal(JSON.stringify(first).includes("secret prompt"), false);
	});

	test("evidence remains a bounded unverified attestation", () => {
		const output = [
			"done",
			"```subagent-evidence",
			JSON.stringify({
				summary: "changed safely",
				changedFiles: ["src/a.ts"],
				commandsRun: ["npm test"],
				validations: ["tests passed"],
				residualRisks: ["none claimed"],
			}),
			"```",
		].join("\n");
		assert.deepEqual(parseEvidenceAttestation(output, "attested"), {
			status: "attested",
			summary: "changed safely",
			changedFiles: ["src/a.ts"],
			commandsRun: ["npm test"],
			validations: ["tests passed"],
			residualRisks: ["none claimed"],
		});
		assert.deepEqual(parseEvidenceAttestation("plain output", "attested"), {
			status: "missing",
		});
		assert.deepEqual(parseEvidenceAttestation(`${output}\n${output}`, "attested"), {
			status: "invalid",
		});
		assert.deepEqual(parseEvidenceAttestation("```subagent-evidence\n{broken}\n```", "attested"), {
			status: "invalid",
		});
		const privateEvidence = parseEvidenceAttestation(
			`\`\`\`subagent-evidence\n${JSON.stringify({
				summary: "<private>secret</private> safe\u001b[31m",
				changedFiles: [],
				commandsRun: [],
				validations: [],
				residualRisks: [],
			})}\n\`\`\``,
			"attested",
		);
		assert.equal(JSON.stringify(privateEvidence).includes("secret"), false);
		assert.equal(JSON.stringify(privateEvidence).includes("\u001b"), false);
		assert.deepEqual(
			parseEvidenceAttestation(
				`\`\`\`subagent-evidence\n${" ".repeat(17 * 1024)}\n\`\`\``,
				"attested",
			),
			{ status: "invalid" },
		);
		assert.equal(parseEvidenceAttestation(output, undefined), undefined);
	});

	test("lifecycle artifacts are private metadata without task or output text", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-subagents-artifact-"));
		const writer = new LifecycleArtifactWriter("session", 30, directory);
		await writer.publish([
			managedAgent({
				currentTask: "PRIVATE task",
				error: "PRIVATE error",
				history: [
					{
						task: "PRIVATE history",
						output: "PRIVATE output",
						startedAt: 1,
						completedAt: 2,
						exitCode: 0,
					},
				],
				mailbox: [
					{
						id: "m1",
						senderId: "root",
						recipientId: "sa_1",
						content: "PRIVATE mail",
						createdAt: 1,
					},
				],
			}),
		]);
		const content = await readFile(writer.filePath, "utf8");
		assert.equal(content.includes("PRIVATE"), false);
		assert.equal(JSON.parse(content).agents[0].historyCount, 1);
		assert.equal((await stat(writer.filePath)).mode & 0o777, 0o600);
		const stale = new LifecycleArtifactWriter("stale", 30, directory, () => false);
		await stale.publish([managedAgent()]);
		await assert.rejects(() => readFile(stale.filePath, "utf8"), /ENOENT/);
		const expired = join(directory, `${"b".repeat(24)}.json`);
		const unrelated = join(directory, "keep.txt");
		await writeFile(expired, "{}", "utf8");
		await writeFile(unrelated, "keep", "utf8");
		await utimes(expired, new Date(0), new Date(0));
		await writer.cleanupExpired();
		await assert.rejects(() => readFile(expired, "utf8"), /ENOENT/);
		assert.equal(await readFile(unrelated, "utf8"), "keep");
		await rm(directory, { recursive: true, force: true });
	});

	test("the current-agent detail exposes state-valid steering without hiding subtree cleanup", () => {
		const parent = managedAgent({
			state: "completed",
			children: ["sa_child"],
			history: [{ task: "done", output: "ok", startedAt: 1, completedAt: 2, exitCode: 0 }],
		});
		const screen = currentAgentDetailScreen({ listAgents: () => [parent] } as never, parent.id);
		const actions = screen.items.map((item) => item.action);
		assert.ok(actions.includes("agent-follow-up"));
		assert.ok(actions.includes("agent-queue-message"));
		assert.ok(actions.includes("agent-interrupt-tree"));
		assert.ok(actions.includes("agent-close-tree"));
		assert.equal(screen.items.find((item) => item.action === "agent-close")?.disabled, true);
	});

	test("FleetView renders bounded text without terminal controls or input listeners", () => {
		let widget: unknown;
		const ui = {
			setWidget(_key: string, content: unknown) {
				widget = content;
			},
		};
		updateFleetWidget({ mode: "tui", ui } as never, true, [managedAgent()]);
		assert.equal(typeof widget, "function");
		const component = (
			widget as (
				tui: unknown,
				theme: { bold(value: string): string; fg(color: string, value: string): string },
			) => { render(width: number): string[] }
		)(undefined, {
			bold: (value: string) => value,
			fg: (_color: string, value: string) => value,
		});
		const lines = component.render(40) as string[];
		assert.match(lines.join("\n"), /RUNNING worker sa_1/);
		assert.equal(lines.join("\n").includes("\u001b"), false);
		assert.ok(lines.every((line) => line.length <= 40));
		const narrow = component.render(4) as string[];
		assert.ok(narrow.every((line) => visibleWidth(line) <= 4));
		updateFleetWidget({ mode: "rpc", ui } as never, true, [managedAgent()]);
		assert.equal(widget, undefined);
	});

	test("the v1 event API binds to a session, rejects duplicate IDs, and cancels exact work", async () => {
		const lifecycle = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
		const bus = new Map<string, Set<(data: unknown) => void>>();
		const emitted: Array<{
			channel: string;
			data: {
				requestId?: string;
				result?: { cancelled?: boolean };
				error?: { code?: string };
			};
		}> = [];
		const pi = {
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
			},
			events: {
				on(channel: string, handler: (data: unknown) => void) {
					const handlers = bus.get(channel) ?? new Set();
					handlers.add(handler);
					bus.set(channel, handlers);
					return () => handlers.delete(handler);
				},
				emit(channel: string, data: unknown) {
					emitted.push({
						channel,
						data: data as {
							requestId?: string;
							result?: { cancelled?: boolean };
							error?: { code?: string };
						},
					});
					for (const handler of bus.get(channel) ?? []) handler(data);
				},
			},
		} as unknown as ExtensionAPI;
		let release!: () => void;
		registerPiSubagentsV1Api(pi, new CapabilityCeilingRegistry(), {
			preflight: () => ({ safe: true }),
			delegate: (_payload, signal) =>
				new Promise((resolve, reject) => {
					release = () => resolve({ done: true });
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});
		const ctx = {} as ExtensionContext;
		for (const handler of lifecycle.get("session_start") ?? []) await handler({}, ctx);
		assert.ok(emitted.some((entry) => entry.channel === PI_SUBAGENTS_V1_READY));
		pi.events.on(PI_SUBAGENTS_V1_REPLY, (value) => {
			if ((value as { requestId?: string }).requestId === "reentrant") {
				pi.events.emit(PI_SUBAGENTS_V1_REQUEST, { requestId: "reentrant", method: "ping" });
			}
		});
		pi.events.emit(PI_SUBAGENTS_V1_REQUEST, { requestId: "reentrant", method: "ping" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(
			emitted.filter(
				(entry) => entry.channel === PI_SUBAGENTS_V1_REPLY && entry.data.requestId === "reentrant",
			).length,
			1,
		);
		pi.events.emit(PI_SUBAGENTS_V1_REQUEST, {
			requestId: "work-1",
			method: "delegate",
			payload: {},
		});
		await Promise.resolve();
		pi.events.emit(PI_SUBAGENTS_V1_REQUEST, {
			requestId: "cancel-1",
			method: "cancel",
			payload: { targetRequestId: "work-1" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const replies = emitted.filter((entry) => entry.channel === PI_SUBAGENTS_V1_REPLY);
		assert.equal(
			replies.find((entry) => entry.data.requestId === "cancel-1")?.data.result?.cancelled,
			true,
		);
		assert.equal(
			replies.find((entry) => entry.data.requestId === "work-1")?.data.error?.code,
			"cancelled",
		);
		const replyCount = emitted.filter(
			(entry) => entry.channel === PI_SUBAGENTS_V1_REPLY && entry.data.requestId === "cancel-1",
		).length;
		pi.events.emit(PI_SUBAGENTS_V1_REQUEST, { requestId: "cancel-1", method: "ping" });
		assert.equal(
			emitted.filter(
				(entry) => entry.channel === PI_SUBAGENTS_V1_REPLY && entry.data.requestId === "cancel-1",
			).length,
			replyCount,
		);
		pi.events.emit(PI_SUBAGENTS_V1_REQUEST, {
			requestId: "work-2",
			method: "delegate",
			payload: {},
		});
		pi.events.emit(PI_SUBAGENTS_V1_REQUEST, { requestId: "work-2", method: "ping" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const duplicateReplies = emitted.filter(
			(entry) => entry.channel === PI_SUBAGENTS_V1_REPLY && entry.data.requestId === "work-2",
		);
		assert.equal(duplicateReplies.length, 1);
		assert.equal(duplicateReplies[0]?.data.error?.code, "duplicate_request");
		pi.events.emit(PI_SUBAGENTS_V1_REQUEST, {
			requestId: "work-3",
			method: "delegate",
			payload: {},
		});
		for (const handler of lifecycle.get("session_start") ?? []) await handler({}, ctx);
		release?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(
			emitted.filter(
				(entry) => entry.channel === PI_SUBAGENTS_V1_REPLY && entry.data.requestId === "work-3",
			).length,
			0,
		);
	});
});
