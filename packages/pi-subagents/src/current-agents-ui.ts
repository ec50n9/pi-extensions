import type { ManagedAgent } from "./registry.js";
import { safeTerminalLine } from "./safe-text.js";
import type { StatefulSubagentRuntimeStatus } from "./stateful.js";
import { formatEmptyStatefulRuntime } from "./stateful-limit-ui.js";
import { formatStatefulAgentLine } from "./stateful-presenter.js";

interface CurrentAgentsRuntime {
	listAgents(includeClosed?: boolean): ManagedAgent[];
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
}

export function currentAgentsScreen(runtime: CurrentAgentsRuntime) {
	const agents = runtime.listAgents();
	const status = runtime.getRuntimeStatus();
	return {
		kind: "actions" as const,
		title: "Current-session Subagents",
		lines: agents.length ? [] : [formatEmptyStatefulRuntime(status)],
		items: [
			...agents.map((agent) => ({
				id: agent.id,
				label: safeTerminalLine(`${agent.agent} · ${agent.state}`, 256),
				description: safeTerminalLine(formatStatefulAgentLine(agent), 512),
				action: "select-agent" as const,
			})),
			...(agents.length > 0
				? [
						{
							id: "clear",
							label: "Clear current-session agents",
							description: "Close and delete retained agents for this session",
							action: "clear-agents" as const,
						},
					]
				: []),
			{ id: "back", label: "Back", action: "back" as const },
		],
		hint: "back" as const,
	};
}

export function currentAgentDetailScreen(
	runtime: CurrentAgentsRuntime,
	agentId: string | undefined,
) {
	const agent = agentId
		? runtime.listAgents(true).find((entry) => entry.id === agentId)
		: undefined;
	if (!agent) {
		return {
			kind: "actions" as const,
			title: "Subagent unavailable",
			lines: ["The selected subagent is no longer retained."],
			items: [{ id: "back", label: "Back", action: "back" as const }],
			hint: "back" as const,
		};
	}
	const running = agent.state === "starting" || agent.state === "running";
	const reusable = ["idle", "completed", "interrupted", "failed"].includes(agent.state);
	const hasDescendants = agent.children.length > 0;
	return {
		kind: "actions" as const,
		title: safeTerminalLine(`${agent.agent} · ${agent.id}`, 256),
		lines: detailLines(agent),
		items: [
			...(reusable
				? [
						{
							id: "follow-up",
							label: "Send follow-up",
							description: "Start another turn with this retained agent",
							action: "agent-follow-up" as const,
						},
					]
				: []),
			...(agent.state !== "closed"
				? [
						{
							id: "queue-message",
							label: "Queue mailbox message",
							description: "Store a message without starting a turn",
							action: "agent-queue-message" as const,
						},
					]
				: []),
			...(running
				? [
						{
							id: "interrupt",
							label: "Interrupt active turn",
							action: "agent-interrupt" as const,
						},
					]
				: []),
			...(hasDescendants
				? [
						{
							id: "interrupt-tree",
							label: "Interrupt subtree",
							description: "Interrupt active work in this agent and its descendants",
							action: "agent-interrupt-tree" as const,
						},
					]
				: []),
			...(agent.state !== "closed"
				? [
						{
							id: "close",
							label: "Close agent",
							description: hasDescendants
								? "Close is unavailable until descendants are closed"
								: "Close the retained agent and release its resources",
							action: "agent-close" as const,
							disabled: hasDescendants,
							disabledReason: hasDescendants ? "Use Close subtree" : undefined,
						},
					]
				: []),
			...(agent.state !== "closed" && hasDescendants
				? [
						{
							id: "close-tree",
							label: "Close subtree",
							description: "Close this agent and every retained descendant",
							action: "agent-close-tree" as const,
						},
					]
				: []),
			{ id: "back", label: "Back", action: "back" as const },
		],
		hint: "back" as const,
	};
}

function detailLines(agent: ManagedAgent): string[] {
	return [
		`State: ${agent.state}`,
		`Agent: ${safeTerminalLine(agent.agent, 256)}`,
		`ID: ${safeTerminalLine(agent.id, 256)}`,
		`Depth: ${agent.depth}`,
		`Children: ${agent.children.length}`,
		`History turns: ${agent.history.length}`,
		`Unread messages: ${agent.mailbox.filter((message) => !message.readAt).length}`,
		`Workspace: ${agent.workspaceMode ?? "shared"}`,
		...(agent.evidenceStatus ? [`Evidence: ${agent.evidenceStatus} (unverified)`] : []),
	];
}
