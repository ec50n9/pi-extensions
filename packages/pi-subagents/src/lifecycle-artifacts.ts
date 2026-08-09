import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ManagedAgent } from "./registry.js";
import { safeTerminalLine } from "./safe-text.js";

const ARTIFACT_VERSION = 1;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_ARTIFACT_AGENTS = 256;

export interface LifecycleArtifactStatus {
	enabled: boolean;
	path?: string;
	version: number;
	lastPublishedAt?: number;
	error?: string;
}

interface LifecycleArtifact {
	version: 1;
	updatedAt: number;
	agents: Array<{
		id: string;
		agent: string;
		parentId?: string;
		rootId: string;
		state: ManagedAgent["state"];
		createdAt: number;
		updatedAt: number;
		historyCount: number;
		unreadMessages: number;
		workspaceMode: "shared" | "worktree";
		trustKind?: string;
		launchContractDigest?: string;
		evidenceStatus?: string;
	}>;
	omittedAgents: number;
}

export class LifecycleArtifactWriter {
	readonly filePath: string;
	private lastPublishedAt?: number;
	private error?: string;
	private closed = false;

	constructor(
		owner: string,
		private readonly retentionDays = 30,
		artifactDir?: string,
		private readonly isCurrent: () => boolean = () => true,
	) {
		if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
			throw new Error("Lifecycle artifact retentionDays must be positive");
		}
		const ownerHash = createHash("sha256").update(owner).digest("hex").slice(0, 24);
		this.filePath = path.join(
			artifactDir ?? path.join(getAgentDir(), "pi-subagents-artifacts"),
			`${ownerHash}.json`,
		);
	}

	status(): LifecycleArtifactStatus {
		return {
			enabled: !this.closed,
			path: this.filePath,
			version: ARTIFACT_VERSION,
			lastPublishedAt: this.lastPublishedAt,
			error: this.error,
		};
	}

	async publish(agents: readonly ManagedAgent[]): Promise<void> {
		if (this.closed || !this.isCurrent()) return;
		const eligible = agents.filter((agent) => agent.state !== "closed");
		const selected = eligible.slice(-MAX_ARTIFACT_AGENTS);
		const artifact: LifecycleArtifact = {
			version: ARTIFACT_VERSION,
			updatedAt: Date.now(),
			agents: selected.map((agent) => ({
				id: agent.id,
				agent: agent.agent,
				...(agent.parentId ? { parentId: agent.parentId } : {}),
				rootId: agent.rootId,
				state: agent.state,
				createdAt: agent.createdAt,
				updatedAt: agent.updatedAt,
				historyCount: agent.history.length,
				unreadMessages: agent.mailbox.filter((message) => message.readAt === undefined).length,
				workspaceMode: agent.workspaceMode ?? "shared",
				...(agent.target?.trust.kind ? { trustKind: agent.target.trust.kind } : {}),
				...(agent.launchContractDigest ? { launchContractDigest: agent.launchContractDigest } : {}),
				...(agent.evidenceStatus ? { evidenceStatus: agent.evidenceStatus } : {}),
			})),
			omittedAgents: eligible.length - selected.length,
		};
		const content = `${JSON.stringify(artifact, null, "\t")}\n`;
		if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) {
			this.error = "Lifecycle artifact exceeded its size limit";
			return;
		}
		try {
			let published = false;
			await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
			await withFileMutationQueue(this.filePath, async () => {
				const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
				try {
					await fs.promises.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
					if (this.closed || !this.isCurrent()) return;
					await fs.promises.rename(temporary, this.filePath);
					published = true;
				} finally {
					await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
				}
			});
			if (!published) return;
			this.lastPublishedAt = artifact.updatedAt;
			this.error = undefined;
		} catch (error) {
			this.error = safeError(error);
		}
	}

	async cleanupExpired(): Promise<void> {
		const directory = path.dirname(this.filePath);
		const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			this.error = safeError(error);
			return;
		}
		for (const entry of entries.slice(0, 1024)) {
			if (this.closed || !this.isCurrent()) return;
			if (!entry.isFile() || !/^[a-f0-9]{24}\.json$/u.test(entry.name)) continue;
			const candidate = path.join(directory, entry.name);
			try {
				const stat = await fs.promises.stat(candidate);
				if (stat.mtimeMs < cutoff) await fs.promises.rm(candidate, { force: true });
			} catch {
				// A concurrent session may have replaced or removed this projection.
			}
		}
	}

	close(): void {
		this.closed = true;
	}
}

export function disabledLifecycleArtifactStatus(): LifecycleArtifactStatus {
	return { enabled: false, version: ARTIFACT_VERSION };
}

function safeError(error: unknown): string {
	return safeTerminalLine(error instanceof Error ? error.message : String(error), 512);
}
