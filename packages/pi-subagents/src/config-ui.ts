import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type CompletionDelivery,
	type ConsultationCwdPolicy,
	type ConsultResourcePolicy,
	type DelegationCwdPolicy,
	discoverAgents,
	type FleetViewMode,
	type LifecycleArtifactsMode,
} from "./agents.js";
import {
	completionLabel,
	consultationCwdLabel,
	consultResourceLabel,
	currentWorkflow,
	delegationCwdLabel,
	fleetViewLabel,
	formatError,
	formatManagerSummary,
	helpLines,
	isWorkflow,
	lifecycleArtifactLabel,
	showSubagentHelp,
	showSubagentStatus,
	statusLines,
} from "./config-status.js";
import { currentAgentDetailScreen, currentAgentsScreen } from "./current-agents-ui.js";
import {
	applyBlockingParallelLimitSetting,
	blockingParallelLimitScreen,
} from "./parallel-limit-ui.js";
import type { ManagedAgent } from "./registry.js";
import { safeTerminalLine as safeTerminalText } from "./safe-text.js";
import {
	hasOwn,
	inspectBlockingParallelLimitSettings,
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	inspectFleetViewSettings,
	inspectLifecycleArtifactSettings,
	readSubagentSettings,
	sameToolSet,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateCompletionDeliverySetting,
	updateConsultResourceSetting,
	updateCwdPolicySetting,
	updateDelegationWorkflowSetting,
	updateFleetViewSetting,
	updateLifecycleArtifactSetting,
} from "./settings.js";
import type { StatefulSubagentRuntimeStatus } from "./stateful.js";
import {
	applyStatefulLimitSetting,
	formatDetachedLimitSummary,
	statefulLimitInputScreen,
	statefulLimitListScreen,
} from "./stateful-limit-ui.js";
import { isStatefulLimitField, type StatefulLimitField } from "./stateful-limits.js";
import { showWorkflowPreview, workflowLabel } from "./workflow-ui.js";

const SUBCOMMANDS = [
	{ value: "settings", label: "settings", description: "Configure subagent user settings" },
	{ value: "status", label: "status", description: "Show effective subagent settings" },
	{ value: "help", label: "help", description: "Show subagent settings help" },
];
const TOOL_VIEWPORT_SIZE = 10;

export interface SubagentSettingsRuntime {
	getBlockingEnabled(): boolean;
	getMaxParallelTasks(): number;
	getCompletionDelivery(): CompletionDelivery;
	getConsultResourcePolicy(): ConsultResourcePolicy;
	getConsultationCwdPolicy(): ConsultationCwdPolicy;
	getDelegationCwdPolicy(): DelegationCwdPolicy;
	setMaxParallelTasks(value: number): void;
	setCompletionDelivery(value: CompletionDelivery): void;
	setConsultResourcePolicy(value: ConsultResourcePolicy): void;
	setConsultationCwdPolicy(value: ConsultationCwdPolicy): void;
	setDelegationCwdPolicy(value: DelegationCwdPolicy): void;
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	getFleetView?(): FleetViewMode;
	getLifecycleArtifactStatus?(): {
		enabled: boolean;
		version: number;
		path?: string;
		error?: string;
	};
	setFleetView?(value: FleetViewMode): void;
	listAgents(includeClosed?: boolean): ManagedAgent[];
	followUp?(
		agentId: string,
		task: string,
		ctx: ExtensionCommandContext,
		signal?: AbortSignal,
	): Promise<ManagedAgent>;
	queueMessage?(agentId: string, message: string): Promise<void>;
	interruptAgent?(agentId: string, subtree?: boolean): Promise<number>;
	closeAgent?(agentId: string, subtree?: boolean): Promise<number>;
	clearAgents(): Promise<number>;
}

export interface SubagentMenuOwner {
	generation: number;
	controller: AbortController;
}

interface ToolDraft {
	agentName: string;
	agentSource: string;
	allTools: string[];
	defaultTools?: string[];
	orderedTools: string[];
	selected: Set<string>;
}

export function registerSubagentConfigLifecycle(pi: ExtensionAPI): SubagentMenuOwner {
	const owner: SubagentMenuOwner = { generation: 0, controller: new AbortController() };
	pi.on("session_start", () => {
		owner.generation += 1;
		owner.controller.abort(new DOMException("Subagent session replaced", "AbortError"));
		owner.controller = new AbortController();
	});
	pi.on("session_shutdown", () => {
		owner.generation += 1;
		owner.controller.abort(new DOMException("Subagent session shut down", "AbortError"));
	});
	return owner;
}

export function registerSubagentConfigCommand(
	pi: ExtensionAPI,
	runtime: SubagentSettingsRuntime,
	owner = registerSubagentConfigLifecycle(pi),
) {
	registerSubagentPrimaryCommand(pi, runtime, owner);
}

function registerSubagentPrimaryCommand(
	pi: ExtensionAPI,
	runtime: SubagentSettingsRuntime,
	owner: SubagentMenuOwner,
) {
	pi.registerCommand("subagents", {
		description: "Manage current-session subagents and user settings",
		getArgumentCompletions(prefix: string) {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const subcommand = args.trim().toLowerCase();
			if (!subcommand) {
				await showSubagentManager(pi, ctx, runtime, owner);
				return;
			}
			switch (subcommand) {
				case "settings":
					await showSubagentSettings(ctx, runtime, owner);
					return;
				case "status":
					showSubagentStatus(ctx, runtime);
					return;
				case "help":
					showSubagentHelp(ctx, runtime);
					return;
				default:
					if (ctx.mode === "tui" || ctx.hasUI) {
						ctx.ui.notify(`Unknown /subagents subcommand: ${subcommand}`, "warning");
					}
			}
		},
	});
}

async function showSubagentManager(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
	owner: SubagentMenuOwner,
) {
	if (ctx.mode !== "tui") {
		showSubagentStatus(ctx, runtime);
		return;
	}
	const generation = owner.generation;
	const isCurrent = () => generation === owner.generation && !owner.controller.signal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isCurrent()) return;
	let availableAgents = discoverAgents(ctx.cwd, "user", readSubagentSettings() ?? {}).agents;
	let toolDraft: ToolDraft | undefined;
	let selectedAgentId: string | undefined;
	let selectedStatefulLimit: StatefulLimitField = "maxAgents";
	type Screen =
		| "main"
		| "workflow"
		| "agents"
		| "agent-detail"
		| "settings"
		| "advanced"
		| "parallel-limit"
		| "stateful-limits"
		| "stateful-limit-input"
		| "status"
		| "help"
		| "agent-picker"
		| "tool-draft";
	type Action =
		| "set-workflow"
		| "select-agent"
		| "agent-follow-up"
		| "agent-queue-message"
		| "agent-interrupt"
		| "agent-interrupt-tree"
		| "agent-close"
		| "agent-close-tree"
		| "clear-agents"
		| "set-parallel-limit"
		| "pick-stateful-limit"
		| "set-stateful-limit"
		| "set-completion"
		| "set-fleet-view"
		| "set-lifecycle-artifacts"
		| "set-consult-resources"
		| "set-consultation-cwd"
		| "set-delegation-cwd"
		| "load-agent-picker"
		| "pick-agent"
		| "toggle-tool"
		| "save-tools"
		| "discard-tools"
		| "back";
	const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: () => {
				const status = runtime.getRuntimeStatus();
				const workflow = inspectDelegationWorkflowSettings();
				return {
					kind: "actions",
					title: "Subagents",
					lines: formatManagerSummary(runtime, status, workflow).split("\n"),
					items: [
						{
							id: "workflow",
							label: "Change delegation",
							description: "Choose all methods, async only, or blocking only",
							to: "workflow",
						},
						{
							id: "agents",
							label: "Current agents",
							description: `${status.activeAgents} active · ${status.retainedAgents} retained`,
							to: "agents",
						},
						{
							id: "settings",
							label: "Settings",
							description: "Configure targets, trusted resources, and async completion",
							to: "settings",
						},
						{
							id: "advanced",
							label: "Advanced settings",
							description: "Agent permissions, parallel limit, runtime details, and settings path",
							to: "advanced",
						},
						{ id: "help", label: "Help", to: "help" },
					],
					hint: "close",
				};
			},
			workflow: () => {
				const snapshot = inspectDelegationWorkflowSettings();
				const active = currentWorkflow(runtime, runtime.getRuntimeStatus());
				return {
					kind: "actions",
					title: "Change Delegation",
					lines: [
						`Current: ${workflowLabel(active)}`,
						...(snapshot.value !== active
							? [`Configured after reload: ${workflowLabel(snapshot.value)}`]
							: []),
						...(snapshot.error
							? [
									`Settings cannot be edited: ${safeTerminalText(snapshot.error)}`,
									`Repair ${safeTerminalText(snapshot.path)} and retry.`,
								]
							: []),
					],
					items: snapshot.error
						? []
						: [
								{
									id: "all",
									label: "All delegation methods",
									description: "Allow blocking batches and reusable async agents",
									action: "set-workflow" as const,
								},
								{
									id: "async-only",
									label: "Async only",
									description: "Keep the root responsive; remove blocking subagent",
									action: "set-workflow" as const,
								},
								{
									id: "blocking-only",
									label: "Blocking only",
									description: "Keep blocking batches; remove reusable async agents",
									action: "set-workflow" as const,
								},
							],
					hint: "back",
				};
			},
			agents: () => currentAgentsScreen(runtime),
			"agent-detail": () => currentAgentDetailScreen(runtime, selectedAgentId),
			settings: () => subagentSettingsScreen(runtime),
			advanced: () => {
				const limit = inspectBlockingParallelLimitSettings();
				return {
					kind: "actions",
					title: "Advanced Subagent Settings",
					items: [
						{
							id: "agent-tools",
							label: "Agent tool permissions",
							description: "Customize persistent per-agent tool allow-lists",
							action: "load-agent-picker",
						},
						{
							id: "status",
							label: "Runtime details",
							description: "Show transport, configured source, and settings path",
							to: "status",
						},
						{
							id: "parallel-limit",
							label: "Maximum parallel workers",
							description: `Current: ${runtime.getMaxParallelTasks()} per blocking call`,
							to: "parallel-limit",
							disabled: limit.error !== undefined,
							disabledReason: limit.error
								? `Repair ${safeTerminalText(limit.path)} before editing this setting`
								: undefined,
						},
						{
							id: "stateful-limits",
							label: "Detached agent limits",
							description: formatDetachedLimitSummary(runtime.getRuntimeStatus()),
							to: "stateful-limits",
						},
						{ id: "back", label: "Back", action: "back" },
					],
					hint: "back",
				};
			},
			"parallel-limit": () => blockingParallelLimitScreen(runtime),
			"stateful-limits": () => statefulLimitListScreen(runtime),
			"stateful-limit-input": () => statefulLimitInputScreen(selectedStatefulLimit, runtime),
			status: () => ({
				kind: "detail",
				title: "Subagent runtime details",
				lines: statusLines(runtime),
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "Subagents help",
				lines: helpLines(runtime),
				hint: "back",
			}),
			"agent-picker": () => {
				const settings = readSubagentSettings() ?? {};
				const configured = settings.agents ?? {};
				return {
					kind: "actions",
					title: "Subagent Tool Configuration",
					lines: ["Select an agent to configure its allowed tools."],
					items: availableAgents.map((agent) => {
						const override = configured[agent.name];
						const hasOverride = override ? hasOwn(override, "tools") : false;
						const summary = hasOverride
							? override?.tools && override.tools.length > 0
								? override.tools.join(", ")
								: "none"
							: "defaults";
						return {
							id: agent.name,
							label: safeTerminalText(agent.name),
							description: safeTerminalText(`${agent.source} · tools: ${summary}`),
							action: "pick-agent" as const,
						};
					}),
					hint: "back",
				};
			},
			"tool-draft": () => ({
				kind: "multiSelect",
				title: toolDraft ? `${safeTerminalText(toolDraft.agentName)} tools` : "Agent tools",
				enableSearch: true,
				lines: toolDraft
					? [
							`Source: ${safeTerminalText(toolDraft.agentSource)}`,
							"Toggle a draft, then Save changes.",
						]
					: ["No agent selected."],
				viewportSize: TOOL_VIEWPORT_SIZE,
				items:
					toolDraft?.orderedTools.map((name) => {
						const available = toolDraft?.allTools.includes(name) ?? false;
						return {
							id: name,
							label: safeTerminalText(name),
							description: available ? "Available tool" : "Configured tool is not currently loaded",
							searchText: available ? "available tool" : "configured unavailable preserved",
							selected: toolDraft?.selected.has(name) ?? false,
							disabled: !available,
							disabledReason: available
								? undefined
								: "Unavailable; preserved until explicitly changed in JSON",
						};
					}) ?? [],
				action: "toggle-tool",
				actions: [
					{ id: "save", label: "Save changes", action: "save-tools" },
					{ id: "discard", label: "Discard draft", action: "discard-tools" },
				],
				hint: "back",
				doneLabel: "Close without saving",
			}),
		},
		actions: {
			"set-workflow": async ({ itemId, signal }) => {
				if (!isWorkflow(itemId)) return { kind: "rejected" };
				const snapshot = inspectDelegationWorkflowSettings();
				if (snapshot.error) return { kind: "rejected" };
				const active = currentWorkflow(runtime, runtime.getRuntimeStatus());
				if (itemId === active && itemId === snapshot.value) {
					ctx.ui.notify(`Delegation already uses ${workflowLabel(itemId)}.`, "info");
					return { kind: "stay" };
				}
				const requiresReload = itemId !== active;
				if (requiresReload && blockReloadWithRetainedAgents(ctx, runtime)) {
					return { kind: "rejected" };
				}
				if (!(await showWorkflowPreview(ctx, active, itemId, requiresReload, signal))) {
					return signal.aborted || !isCurrent() ? { kind: "close" } : { kind: "rejected" };
				}
				if (signal.aborted || !isCurrent()) return { kind: "close" };
				if (requiresReload && blockReloadWithRetainedAgents(ctx, runtime)) {
					return { kind: "rejected" };
				}
				try {
					updateDelegationWorkflowSetting(itemId);
				} catch (error) {
					ctx.ui.notify(
						`Delegation settings were not saved: ${formatError(error)}. The current workflow is unchanged.`,
						"error",
					);
					return { kind: "rejected" };
				}
				if (!requiresReload) {
					ctx.ui.notify(
						`Saved ${workflowLabel(itemId)}. The current tool surface already matches.`,
						"info",
					);
					return { kind: "stay" };
				}
				ctx.ui.notify(
					`Saved ${workflowLabel(itemId)}. Reloading subagent tools… If the tool surface does not refresh, run /reload.`,
					"info",
				);
				await ctx.reload();
				return { kind: "close" };
			},
			"select-agent": async ({ itemId }) => {
				if (!runtime.listAgents(true).some((agent) => agent.id === itemId)) {
					return { kind: "rejected" };
				}
				selectedAgentId = itemId;
				return { kind: "to", screen: "agent-detail" };
			},
			"agent-follow-up": async ({ signal }) => {
				if (!selectedAgentId || !runtime.followUp) return { kind: "rejected" };
				const task = await ctx.ui.input("Send subagent follow-up", "Describe the next task", {
					signal,
				});
				if (signal.aborted || !isCurrent()) return { kind: "close" };
				if (!task?.trim()) return { kind: "rejected" };
				try {
					await runtime.followUp(selectedAgentId, task, ctx, signal);
					if (signal.aborted || !isCurrent()) return { kind: "close" };
					ctx.ui.notify("Subagent follow-up started.", "info");
					return { kind: "stay" };
				} catch (error) {
					ctx.ui.notify(`Follow-up was not started: ${formatError(error)}`, "error");
					return { kind: "rejected" };
				}
			},
			"agent-queue-message": async ({ signal }) => {
				if (!selectedAgentId || !runtime.queueMessage) return { kind: "rejected" };
				const message = await ctx.ui.input("Queue mailbox message", "Message for the subagent", {
					signal,
				});
				if (signal.aborted || !isCurrent()) return { kind: "close" };
				if (!message?.trim()) return { kind: "rejected" };
				try {
					await runtime.queueMessage(selectedAgentId, message);
					if (signal.aborted || !isCurrent()) return { kind: "close" };
					ctx.ui.notify("Mailbox message queued.", "info");
					return { kind: "stay" };
				} catch (error) {
					ctx.ui.notify(`Mailbox message was not queued: ${formatError(error)}`, "error");
					return { kind: "rejected" };
				}
			},
			"agent-interrupt": async () => applyAgentInterrupt(runtime, selectedAgentId, false, ctx),
			"agent-interrupt-tree": async () => applyAgentInterrupt(runtime, selectedAgentId, true, ctx),
			"agent-close": async ({ signal }) =>
				applyAgentClose(runtime, selectedAgentId, false, ctx, signal, isCurrent),
			"agent-close-tree": async ({ signal }) =>
				applyAgentClose(runtime, selectedAgentId, true, ctx, signal, isCurrent),
			"clear-agents": async ({ signal }) => {
				const agents = runtime.listAgents();
				if (agents.length === 0) return { kind: "stay" };
				const confirmed = await ctx.ui.confirm(
					"Clear current-session subagents?",
					`Close and delete ${agents.length} retained agent${agents.length === 1 ? "" : "s"}?`,
					{ signal },
				);
				if (signal.aborted || !isCurrent()) return { kind: "close" };
				if (!confirmed) return { kind: "rejected" };
				if (
					runtime
						.listAgents()
						.map((agent) => agent.id)
						.join("\0") !== agents.map((agent) => agent.id).join("\0")
				) {
					ctx.ui.notify(
						"Detached agents changed while confirming; review the list again.",
						"warning",
					);
					return { kind: "rejected" };
				}
				const cleared = await runtime.clearAgents();
				if (signal.aborted || !isCurrent()) return { kind: "close" };
				ctx.ui.notify(
					`Cleared ${cleared} current-session subagent${cleared === 1 ? "" : "s"}.`,
					"info",
				);
				return { kind: "stay" };
			},
			"set-parallel-limit": async ({ value }) =>
				applyBlockingParallelLimitSetting(value, ctx, runtime),
			"pick-stateful-limit": async ({ itemId }) => {
				if (!isStatefulLimitField(itemId)) return { kind: "rejected" };
				selectedStatefulLimit = itemId;
				return { kind: "to", screen: "stateful-limit-input" };
			},
			"set-stateful-limit": async ({ value, signal }) =>
				applyStatefulLimitSetting(selectedStatefulLimit, value, ctx, runtime, {
					signal,
					isCurrent,
				}),
			"set-completion": async ({ value }) => applyCompletionSetting(value, ctx, runtime),
			"set-fleet-view": async ({ value }) => applyFleetViewSetting(value, ctx, runtime),
			"set-lifecycle-artifacts": async ({ value }) => applyLifecycleArtifactSetting(value, ctx),
			"set-consult-resources": async ({ value }) =>
				applyConsultResourceSetting(value, ctx, runtime),
			"set-consultation-cwd": async ({ value }) => applyConsultationCwdSetting(value, ctx, runtime),
			"set-delegation-cwd": async ({ value }) => applyDelegationCwdSetting(value, ctx, runtime),
			"load-agent-picker": async () => {
				availableAgents = discoverAgents(ctx.cwd, "user", readSubagentSettings() ?? {}).agents;
				if (availableAgents.length === 0) {
					ctx.ui.notify("No agents found", "warning");
					return { kind: "rejected" };
				}
				return { kind: "to", screen: "agent-picker" };
			},
			"pick-agent": async ({ itemId }) => {
				const agent = availableAgents.find((candidate) => candidate.name === itemId);
				if (!agent) return { kind: "rejected" };
				const settings = readSubagentSettings() ?? {};
				const configured = settings.agents?.[agent.name];
				const configuredTools =
					configured && hasOwn(configured, "tools") ? (configured.tools ?? []) : undefined;
				const defaults = discoverAgents(ctx.cwd, "user").agents.find(
					(candidate) => candidate.name === agent.name,
				)?.tools;
				const allTools = uniqueToolNames(pi.getAllTools().map((tool) => tool.name)).sort((a, b) =>
					a.localeCompare(b),
				);
				const selected = uniqueToolNames(configuredTools ?? defaults ?? allTools);
				const selectedSet = new Set(selected);
				toolDraft = {
					agentName: agent.name,
					agentSource: agent.source,
					allTools,
					defaultTools: defaults,
					orderedTools: [...selected, ...allTools.filter((name) => !selectedSet.has(name))],
					selected: selectedSet,
				};
				return { kind: "to", screen: "tool-draft" };
			},
			"toggle-tool": async ({ itemId, selected }) => {
				if (!toolDraft?.allTools.includes(itemId)) return { kind: "rejected" };
				if (selected) toolDraft.selected.add(itemId);
				else toolDraft.selected.delete(itemId);
				return { kind: "stay" };
			},
			"save-tools": async () => {
				if (!toolDraft) return { kind: "rejected" };
				const selected = toolDraft.orderedTools.filter((name) => toolDraft?.selected.has(name));
				const restoredDefaults =
					toolDraft.defaultTools === undefined
						? sameToolSet(selected, toolDraft.allTools)
						: sameToolSet(selected, toolDraft.defaultTools);
				try {
					updateAgentToolsSetting(toolDraft.agentName, restoredDefaults ? undefined : selected);
				} catch (error) {
					ctx.ui.notify(`Agent tool settings were not saved: ${formatError(error)}`, "error");
					return { kind: "rejected" };
				}
				ctx.ui.notify(
					restoredDefaults
						? `${safeTerminalText(toolDraft.agentName)}: defaults restored`
						: `${safeTerminalText(toolDraft.agentName)}: ${selected.length} tool${selected.length === 1 ? "" : "s"} configured`,
					"info",
				);
				toolDraft = undefined;
				return { kind: "back" };
			},
			"discard-tools": async () => {
				toolDraft = undefined;
				return { kind: "back" };
			},
			back: async () => ({ kind: "back" }),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: owner.controller.signal,
		isCurrent,
	});
}

async function showSubagentSettings(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
	owner: SubagentMenuOwner,
) {
	const snapshot = inspectConsultResourceSettings();
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`User settings apply to this and future sessions. Edit settings manually: ${safeTerminalText(snapshot.path)}`,
				"info",
			);
		}
		return;
	}
	const generation = owner.generation;
	const isCurrent = () => generation === owner.generation && !owner.controller.signal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isCurrent()) return;
	type SettingsAction =
		| "set-completion"
		| "set-fleet-view"
		| "set-lifecycle-artifacts"
		| "set-consult-resources"
		| "set-consultation-cwd"
		| "set-delegation-cwd";
	const menu = defineMenu<undefined, "settings", SettingsAction, ExtensionCommandContext>({
		start: "settings",
		screens: { settings: () => subagentSettingsScreen(runtime) },
		actions: {
			"set-completion": async ({ value }) => applyCompletionSetting(value, ctx, runtime),
			"set-fleet-view": async ({ value }) => applyFleetViewSetting(value, ctx, runtime),
			"set-lifecycle-artifacts": async ({ value }) => applyLifecycleArtifactSetting(value, ctx),
			"set-consult-resources": async ({ value }) =>
				applyConsultResourceSetting(value, ctx, runtime),
			"set-consultation-cwd": async ({ value }) => applyConsultationCwdSetting(value, ctx, runtime),
			"set-delegation-cwd": async ({ value }) => applyDelegationCwdSetting(value, ctx, runtime),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: owner.controller.signal,
		isCurrent,
	});
}

function subagentSettingsScreen(runtime: SubagentSettingsRuntime) {
	const completion = inspectCompletionDeliverySettings();
	const fleet = inspectFleetViewSettings();
	const artifacts = inspectLifecycleArtifactSettings();
	const consult = inspectConsultResourceSettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const error =
		completion.error ?? fleet.error ?? artifacts.error ?? consult.error ?? cwdPolicy.error;
	return {
		kind: "settings" as const,
		title: error ? "Subagent User Settings · Read only" : "Subagent User Settings",
		lines: [
			"Applies now and to future sessions",
			"Target and trust settings control startup resources, not filesystem access or sandboxing.",
			"Manage folder trust with Pi /trust; restart Pi after changing it.",
			safeTerminalText(consult.path),
			...(error ? [`Settings cannot be edited: ${safeTerminalText(error)}`] : []),
		],
		items: error
			? []
			: [
					{
						id: "consultationCwd",
						label: "Read-only consultation target",
						description:
							"Untrusted external targets inherit no target/project resources; agent and package read-only prompts remain.",
						currentValue: consultationCwdLabel(runtime.getConsultationCwdPolicy()),
						values: ["Anywhere · untrusted targets inherit nothing", "Current workspace only"],
						action: "set-consultation-cwd" as const,
					},
					{
						id: "delegationCwd",
						label: "General delegation target",
						description:
							"Controls starting directories, not absolute paths, shell commands, or OS permissions.",
						currentValue: delegationCwdLabel(runtime.getDelegationCwdPolicy()),
						values: [
							"Current or saved-trusted folders",
							"Current workspace only",
							"Anywhere · normal Pi permissions",
						],
						action: "set-delegation-cwd" as const,
					},
					{
						id: "consultResources",
						label: "Consultation resources for trusted targets",
						description:
							"Choose which trusted context, system, skill, and prompt resources a consultation inherits.",
						currentValue: consultResourceLabel(runtime.getConsultResourcePolicy()),
						values: ["Project context only", "No inherited resources", "All trusted resources"],
						action: "set-consult-resources" as const,
					},
					{
						id: "completionDelivery",
						label: "When async work finishes",
						description:
							"Wait for your next turn, or request one synthesis turn after the root settles.",
						currentValue: completionLabel(runtime.getCompletionDelivery()),
						values: ["Wait until my next turn", "Resume automatically when finished"],
						action: "set-completion" as const,
					},
					{
						id: "fleetView",
						label: "Active-agent FleetView",
						description: "Show a read-only status widget below the editor without capturing keys.",
						currentValue: fleetViewLabel(runtime.getFleetView?.() ?? "off"),
						values: ["Off", "Show active agents"],
						action: "set-fleet-view" as const,
					},
					{
						id: "lifecycleArtifacts",
						label: "Lifecycle metadata artifact",
						description: "Publish bounded metadata after reload; excludes tasks and outputs.",
						currentValue: lifecycleArtifactLabel(artifacts.value),
						values: ["Off", "Metadata after reload"],
						action: "set-lifecycle-artifacts" as const,
					},
				],
	};
}

async function applyAgentInterrupt(
	runtime: SubagentSettingsRuntime,
	agentId: string | undefined,
	subtree: boolean,
	ctx: ExtensionCommandContext,
) {
	if (!agentId || !runtime.interruptAgent) return { kind: "rejected" as const };
	try {
		const count = await runtime.interruptAgent(agentId, subtree);
		ctx.ui.notify(`Interrupted ${count} active subagent${count === 1 ? "" : "s"}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent was not interrupted: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

async function applyAgentClose(
	runtime: SubagentSettingsRuntime,
	agentId: string | undefined,
	subtree: boolean,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
	isCurrent: () => boolean,
) {
	if (!agentId || !runtime.closeAgent) return { kind: "rejected" as const };
	const before = runtime.listAgents(true).find((agent) => agent.id === agentId);
	if (!before) return { kind: "rejected" as const };
	const count = subtree ? countSubtree(runtime.listAgents(true), agentId) : 1;
	const confirmed = await ctx.ui.confirm(
		subtree ? "Close subagent subtree?" : "Close subagent?",
		`Close ${count} retained agent${count === 1 ? "" : "s"} and release owned resources?`,
		{ signal },
	);
	if (signal.aborted || !isCurrent()) return { kind: "close" as const };
	if (!confirmed) return { kind: "rejected" as const };
	const current = runtime.listAgents(true).find((agent) => agent.id === agentId);
	if (!current || current.updatedAt !== before.updatedAt || current.state !== before.state) {
		ctx.ui.notify("Subagent state changed while confirming; review it again.", "warning");
		return { kind: "rejected" as const };
	}
	try {
		const closed = await runtime.closeAgent(agentId, subtree);
		if (signal.aborted || !isCurrent()) return { kind: "close" as const };
		ctx.ui.notify(`Closed ${closed} subagent${closed === 1 ? "" : "s"}.`, "info");
		return { kind: "to" as const, screen: "agents" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent was not closed: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function countSubtree(agents: ReturnType<SubagentSettingsRuntime["listAgents"]>, rootId: string) {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const seen = new Set<string>();
	const visit = (id: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		for (const child of byId.get(id)?.children ?? []) visit(child);
	};
	visit(rootId);
	return seen.size;
}

function applyCompletionSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getCompletionDelivery();
	const next: CompletionDelivery =
		value === "Resume automatically when finished" ? "auto-resume" : "next-turn";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCompletionDeliverySetting(next);
		runtime.setCompletionDelivery(next);
		ctx.ui.notify(`Saved and applied: ${completionLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyFleetViewSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getFleetView?.() ?? "off";
	const next: FleetViewMode = value === "Show active agents" ? "active" : "off";
	if (next === previous) return { kind: "stay" as const };
	let applied = false;
	try {
		if (!runtime.setFleetView) throw new Error("FleetView is unavailable in this runtime");
		runtime.setFleetView(next);
		applied = true;
		updateFleetViewSetting(next);
		ctx.ui.notify(`Saved and applied: ${fleetViewLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		if (applied) {
			try {
				runtime.setFleetView?.(previous);
			} catch (rollbackError) {
				ctx.ui.notify(
					`FleetView could not be saved or rolled back: ${formatError(new AggregateError([error, rollbackError]))}. Reopen settings before retrying.`,
					"error",
				);
				return { kind: "rejected" as const };
			}
		}
		ctx.ui.notify(`FleetView setting was not applied: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyLifecycleArtifactSetting(value: string | undefined, ctx: ExtensionCommandContext) {
	const next: LifecycleArtifactsMode = value === "Metadata after reload" ? "metadata" : "off";
	try {
		updateLifecycleArtifactSetting(next);
		ctx.ui.notify(`Saved: ${lifecycleArtifactLabel(next)}. Run /reload to apply.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Lifecycle artifact setting was not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyConsultResourceSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getConsultResourcePolicy();
	const next: ConsultResourcePolicy =
		value === "No inherited resources"
			? "none"
			: value === "All trusted resources"
				? "all"
				: "project-context";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateConsultResourceSetting(next);
		runtime.setConsultResourcePolicy(next);
		ctx.ui.notify(`Saved and applied: ${consultResourceLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyConsultationCwdSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getConsultationCwdPolicy();
	const next: ConsultationCwdPolicy =
		value === "Current workspace only" ? "current-workspace" : "anywhere";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCwdPolicySetting("consultation", next);
		runtime.setConsultationCwdPolicy(next);
		ctx.ui.notify(`Saved and applied: ${consultationCwdLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyDelegationCwdSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getDelegationCwdPolicy();
	const next: DelegationCwdPolicy =
		value === "Current workspace only"
			? "current-workspace"
			: value === "Anywhere · normal Pi permissions"
				? "anywhere"
				: "trusted-targets";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCwdPolicySetting("delegation", next);
		runtime.setDelegationCwdPolicy(next);
		ctx.ui.notify(`Saved and applied: ${delegationCwdLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function blockReloadWithRetainedAgents(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
): boolean {
	const status = runtime.getRuntimeStatus();
	if (status.retainedAgents === 0) return false;
	ctx.ui.notify(
		`Cannot reload while ${status.retainedAgents} detached subagent${status.retainedAgents === 1 ? " is" : "s are"} retained (${status.activeAgents} active). Open Current agents and clear them after their work is safe to discard, then change delegation.`,
		"warning",
	);
	return true;
}
