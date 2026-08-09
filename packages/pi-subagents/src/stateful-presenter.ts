import { truncateUtf8 } from "./limits.js";
import type { ManagedAgent } from "./registry.js";

const MAX_TOOL_MESSAGE_BYTES = 2 * 1024;

export function formatStatefulAgentLine(agent: ManagedAgent): string {
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - agent.updatedAt) / 1000));
	const actions =
		agent.state === "running" || agent.state === "starting"
			? "interrupt, close"
			: agent.state === "closed"
				? "inspect"
				: "send, close";
	const task = agent.currentTask ? ` — ${sanitizeStatusLine(agent.currentTask, 80)}` : "";
	const unread = agent.mailbox.filter((message) => !message.readAt).length;
	const indent = "  ".repeat(agent.depth);
	const thinking = agent.thinkingLevel ? ` thinking:${agent.thinkingLevel}` : "";
	return `${indent}${sanitizeStatusLine(agent.id, 128)} ${sanitizeStatusLine(agent.agent, 128)} ${agent.state} ${elapsedSeconds}s${thinking} unread:${unread} [${actions}]${task}`;
}

export function summarizeStatefulAgent(agent: ManagedAgent) {
	return {
		id: agent.id,
		agent: agent.agent,
		parentId: agent.parentId,
		rootId: agent.rootId,
		depth: agent.depth,
		children: [...agent.children],
		state: agent.state,
		createdAt: agent.createdAt,
		updatedAt: agent.updatedAt,
		cwd: agent.cwd,
		workspaceMode: agent.workspaceMode ?? "shared",
		thinkingLevel: agent.thinkingLevel,
		currentTask: agent.currentTask
			? truncateUtf8(agent.currentTask, MAX_TOOL_MESSAGE_BYTES).text
			: undefined,
		historyCount: agent.history.length,
		unreadMessages: agent.mailbox.filter((message) => !message.readAt).length,
		error: agent.error ? truncateUtf8(agent.error, MAX_TOOL_MESSAGE_BYTES).text : undefined,
		target: agent.target,
		policy: agent.policy,
		evidenceStatus: agent.evidenceStatus,
		launchContractDigest: agent.launchContractDigest,
		capabilityTools: agent.capabilityTools ? [...agent.capabilityTools] : undefined,
		disableExtensions: agent.disableExtensions,
	};
}

function sanitizeStatusLine(value: string, maxLength: number): string {
	return (
		value
			.slice(0, maxLength)
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
			.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
			.replace(/\s+/gu, " ")
			.trim()
	);
}
