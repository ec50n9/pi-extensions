import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { projectAgentRecords } from "./agent-projection.js";
import { isThinkingLevel } from "./agents.js";
import { redactPrivateText } from "./context.js";
import type { EvidenceAttestation } from "./evidence.js";
import type { ManagedAgent } from "./registry.js";
import { resolveStatefulLimits } from "./stateful-limits.js";

const STATE_VERSION = 2;
const DEFAULT_STATEFUL_LIMITS = resolveStatefulLimits();
const MAX_STATE_BYTES = 1024 * 1024;

interface StoredState {
	version: 2;
	updatedAt: number;
	agents: ManagedAgent[];
}

export interface PersistenceOptions {
	retentionDays?: number;
	maxStoredAgents?: number;
	stateDir?: string;
}

export class AgentPersistence {
	readonly filePath: string;
	private readonly retentionMs: number;
	private readonly maxStoredAgents: number;

	constructor(owner: string, options: PersistenceOptions = {}) {
		const retentionDays = options.retentionDays ?? 30;
		if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
			throw new Error("Subagent retentionDays must be a positive finite number");
		}
		const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
		if (!Number.isFinite(retentionMs)) {
			throw new Error("Subagent retentionDays is too large");
		}
		const maxStoredAgents = options.maxStoredAgents ?? DEFAULT_STATEFUL_LIMITS.maxStoredAgents;
		if (!Number.isSafeInteger(maxStoredAgents) || maxStoredAgents < 1) {
			throw new Error("Subagent maxStoredAgents must be a positive safe integer");
		}
		const safeOwner = createHash("sha256").update(owner).digest("hex").slice(0, 24);
		const stateDir = options.stateDir ?? path.join(getAgentDir(), "pi-subagents-state");
		this.filePath = path.join(stateDir, `${safeOwner}.json`);
		this.retentionMs = retentionMs;
		this.maxStoredAgents = maxStoredAgents;
	}

	load(): ManagedAgent[] {
		if (!fs.existsSync(this.filePath)) return [];
		try {
			const stat = fs.statSync(this.filePath);
			if (stat.size > MAX_STATE_BYTES) throw new Error("state exceeds size limit");
			const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
			if (!isStoredState(parsed)) throw new Error("unsupported or malformed state");
			const cutoff = Date.now() - this.retentionMs;
			return projectAgentRecords(
				parsed.agents.filter((agent) => agent.updatedAt >= cutoff && agent.state !== "closed"),
				{ maxAgents: this.maxStoredAgents },
			).map(sanitizeAgent);
		} catch {
			this.quarantine();
			return [];
		}
	}

	async save(agents: readonly ManagedAgent[]): Promise<void> {
		const cutoff = Date.now() - this.retentionMs;
		const eligible = agents.filter(
			(agent) => agent.state !== "closed" && agent.updatedAt >= cutoff,
		);
		const records = projectAgentRecords(eligible, {
			maxAgents: this.maxStoredAgents,
		}).map(sanitizeAgent);
		const state: StoredState = { version: STATE_VERSION, updatedAt: Date.now(), agents: records };
		let content = `${JSON.stringify(state, null, "\t")}\n`;
		while (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES && state.agents.length > 0) {
			const oldestRootId = state.agents[0].rootId;
			state.agents = state.agents.filter((agent) => agent.rootId !== oldestRootId);
			content = `${JSON.stringify(state, null, "\t")}\n`;
		}
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
		await withFileMutationQueue(this.filePath, async () => {
			const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
			await fs.promises.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
			await fs.promises.rename(tempPath, this.filePath);
		});
	}

	async delete(): Promise<void> {
		await withFileMutationQueue(this.filePath, async () => {
			await fs.promises.rm(this.filePath, { force: true });
		});
	}

	private quarantine(): void {
		try {
			fs.renameSync(this.filePath, `${this.filePath}.invalid-${Date.now()}`);
		} catch {
			// A concurrent process may already have moved or removed it.
		}
	}
}

function sanitizeAgent(agent: ManagedAgent): ManagedAgent {
	return {
		...agent,
		rootId: agent.rootId ?? agent.id,
		depth: agent.depth ?? 0,
		children: [...(agent.children ?? [])],
		mailbox: (agent.mailbox ?? []).map((message) => ({
			...message,
			recipientId: agent.id,
			content: redactPrivateText(message.content),
		})),
		state: "idle",
		currentTask: undefined,
		currentMailboxMessageIds: undefined,
		context: agent.context ? redactPrivateText(agent.context) : undefined,
		error: agent.error ? redactPrivateText(agent.error) : undefined,
		history: agent.history.map((turn) => ({
			...turn,
			task: redactPrivateText(turn.task),
			output: redactPrivateText(turn.output),
			evidence: turn.evidence ? sanitizeEvidence(turn.evidence) : undefined,
		})),
		capabilityTools: agent.capabilityTools ? [...agent.capabilityTools] : undefined,
	};
}

function isStoredState(value: unknown): value is StoredState {
	if (!value || typeof value !== "object") return false;
	const state = value as { version?: unknown; agents?: unknown };
	if ((state.version !== 1 && state.version !== STATE_VERSION) || !Array.isArray(state.agents)) {
		return false;
	}
	return state.agents.every((agent) => {
		if (!agent || typeof agent !== "object") return false;
		const record = agent as Partial<ManagedAgent>;
		return (
			typeof record.id === "string" &&
			typeof record.agent === "string" &&
			typeof record.cwd === "string" &&
			typeof record.createdAt === "number" &&
			Number.isFinite(record.createdAt) &&
			typeof record.updatedAt === "number" &&
			Number.isFinite(record.updatedAt) &&
			(record.parentId === undefined || typeof record.parentId === "string") &&
			(record.thinkingLevel === undefined || isThinkingLevel(record.thinkingLevel)) &&
			(record.workspaceMode === undefined || record.workspaceMode === "worktree") &&
			(record.evidencePolicy === undefined || record.evidencePolicy === "attested") &&
			(record.evidenceStatus === undefined ||
				["attested", "missing", "invalid"].includes(record.evidenceStatus)) &&
			(record.launchContractDigest === undefined ||
				(typeof record.launchContractDigest === "string" &&
					/^[a-f0-9]{24}$/u.test(record.launchContractDigest))) &&
			(record.capabilityTools === undefined ||
				(Array.isArray(record.capabilityTools) &&
					record.capabilityTools.length <= 256 &&
					record.capabilityTools.every(
						(tool) => typeof tool === "string" && Buffer.byteLength(tool, "utf8") <= 256,
					))) &&
			(record.disableExtensions === undefined || typeof record.disableExtensions === "boolean") &&
			(record.target === undefined || isTargetPolicyAudit(record.target)) &&
			(record.children === undefined ||
				(Array.isArray(record.children) &&
					record.children.every((id) => typeof id === "string"))) &&
			Array.isArray(record.history) &&
			record.history.every(isAgentTurn) &&
			(record.mailbox === undefined ||
				(Array.isArray(record.mailbox) && record.mailbox.every(isMailboxMessage)))
		);
	});
}

function isTargetPolicyAudit(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const target = value as Record<string, unknown>;
	if (
		typeof target.cwd !== "string" ||
		(target.boundary !== "current-workspace" && target.boundary !== "external") ||
		!target.trust ||
		typeof target.trust !== "object"
	) {
		return false;
	}
	const trust = target.trust as Record<string, unknown>;
	return (
		[
			"session-trusted",
			"session-untrusted",
			"saved-trusted",
			"saved-denied",
			"unsaved",
			"trust-error",
		].includes(String(trust.kind)) &&
		typeof trust.projectTrusted === "boolean" &&
		(trust.sourcePath === undefined || typeof trust.sourcePath === "string") &&
		(trust.warning === undefined || typeof trust.warning === "string")
	);
}

function isAgentTurn(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const turn = value as Record<string, unknown>;
	return (
		typeof turn.task === "string" &&
		typeof turn.output === "string" &&
		typeof turn.startedAt === "number" &&
		Number.isFinite(turn.startedAt) &&
		typeof turn.completedAt === "number" &&
		Number.isFinite(turn.completedAt) &&
		typeof turn.exitCode === "number" &&
		Number.isFinite(turn.exitCode) &&
		(turn.evidence === undefined || isEvidence(turn.evidence))
	);
}

function isEvidence(value: unknown): value is EvidenceAttestation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const evidence = value as Record<string, unknown>;
	if (!["attested", "missing", "invalid"].includes(String(evidence.status))) return false;
	if (
		evidence.summary !== undefined &&
		(typeof evidence.summary !== "string" || Buffer.byteLength(evidence.summary, "utf8") > 2048)
	) {
		return false;
	}
	return ["changedFiles", "commandsRun", "validations", "residualRisks"].every((field) => {
		const fieldValue = evidence[field];
		return (
			fieldValue === undefined ||
			(Array.isArray(fieldValue) &&
				fieldValue.length <= 32 &&
				fieldValue.every(
					(item) => typeof item === "string" && Buffer.byteLength(item, "utf8") <= 2048,
				))
		);
	});
}

function sanitizeEvidence(evidence: EvidenceAttestation): EvidenceAttestation {
	return {
		...evidence,
		summary: evidence.summary ? redactPrivateText(evidence.summary) : undefined,
		changedFiles: evidence.changedFiles?.map(redactPrivateText),
		commandsRun: evidence.commandsRun?.map(redactPrivateText),
		validations: evidence.validations?.map(redactPrivateText),
		residualRisks: evidence.residualRisks?.map(redactPrivateText),
	};
}

function isMailboxMessage(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.id === "string" &&
		typeof message.senderId === "string" &&
		typeof message.recipientId === "string" &&
		typeof message.content === "string" &&
		typeof message.createdAt === "number" &&
		Number.isFinite(message.createdAt) &&
		(message.readAt === undefined ||
			(typeof message.readAt === "number" && Number.isFinite(message.readAt))) &&
		(message.deduplicationKey === undefined || typeof message.deduplicationKey === "string")
	);
}
