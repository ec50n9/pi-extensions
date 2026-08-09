import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	CompletionDelivery,
	ConsultationCwdPolicy,
	ConsultResourcePolicy,
	DelegationCwdPolicy,
	FleetViewMode,
	LifecycleArtifactsMode,
} from "./agents.js";
import type { SubagentSettingsRuntime } from "./config-ui.js";
import { safeTerminalLine as safeTerminalText } from "./safe-text.js";
import {
	type DelegationWorkflow,
	inspectBlockingParallelLimitSettings,
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	inspectLifecycleArtifactSettings,
	inspectStatefulLimitSettings,
} from "./settings.js";
import type { StatefulSubagentRuntimeStatus } from "./stateful.js";
import {
	formatConfiguredDetachedLimitDivergence,
	formatConfiguredDetachedLimits,
	formatDetachedLimitSummary,
} from "./stateful-limit-ui.js";
import { STATEFUL_LIMIT_DEFINITIONS } from "./stateful-limits.js";
import { workflowLabel } from "./workflow-ui.js";

export function showSubagentStatus(ctx: ExtensionCommandContext, runtime: SubagentSettingsRuntime) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	const snapshot = inspectCompletionDeliverySettings();
	ctx.ui.notify(
		formatStatus(runtime.getRuntimeStatus(), snapshot, runtime),
		snapshot.error ? "warning" : "info",
	);
}

export function showSubagentHelp(ctx: ExtensionCommandContext, runtime: SubagentSettingsRuntime) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	ctx.ui.notify(helpLines(runtime).join("\n"), "info");
}

export function statusLines(runtime: SubagentSettingsRuntime): string[] {
	const snapshot = inspectCompletionDeliverySettings();
	return formatStatus(runtime.getRuntimeStatus(), snapshot, runtime).split("\n");
}

export function helpLines(runtime: SubagentSettingsRuntime): string[] {
	const snapshot = inspectCompletionDeliverySettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const parallelLimit = inspectBlockingParallelLimitSettings();
	const detachedLimits = inspectStatefulLimitSettings();
	return [
		"/subagents — choose delegation workflow, manage current agents, and configure agent tools",
		"/subagents settings — configure target locations, trusted resources, and async completion",
		"/subagents status — show current-session and user-setting values",
		"/subagents help — show this help",
		"Target policies control startup directories and resources, not filesystem access or sandboxing.",
		"Manage saved folder trust with Pi /trust and restart Pi after changing it.",
		`Runtime consultation target: ${consultationCwdLabel(runtime.getConsultationCwdPolicy())}`,
		`Configured consultation target: ${consultationCwdLabel(cwdPolicy.consultation.value)} (${cwdPolicy.consultation.source})`,
		`Runtime delegation target: ${delegationCwdLabel(runtime.getDelegationCwdPolicy())}`,
		`Configured delegation target: ${delegationCwdLabel(cwdPolicy.delegation.value)} (${cwdPolicy.delegation.source})`,
		`Maximum parallel workers: ${runtime.getMaxParallelTasks()} per blocking call`,
		`Configured parallel limit: ${parallelLimit.value} (${parallelLimit.source})`,
		`Detached limits: ${formatDetachedLimitSummary(runtime.getRuntimeStatus())}`,
		`FleetView: ${fleetViewLabel(runtime.getFleetView?.() ?? "off")}`,
		`Lifecycle artifact: ${lifecycleArtifactLabel(inspectLifecycleArtifactSettings().value)} (after reload)`,
		...(detachedLimits.values
			? [`Configured detached limits: ${formatConfiguredDetachedLimits(detachedLimits.values)}`]
			: ["Configured detached limits: unavailable; repair user settings"]),
		"Detached limits apply after /reload; clear retained agents first if their work must not be interrupted.",
		`User settings: ${safeTerminalText(snapshot.path)}`,
	];
}

export function formatManagerSummary(
	runtime: SubagentSettingsRuntime,
	status: StatefulSubagentRuntimeStatus,
	configured: ReturnType<typeof inspectDelegationWorkflowSettings>,
): string {
	const current = currentWorkflow(runtime, status);
	const cwdPolicy = inspectCwdPolicySettings();
	const consult = inspectConsultResourceSettings();
	const detachedLimits = inspectStatefulLimitSettings();
	const detachedDivergence = detachedLimits.values
		? formatConfiguredDetachedLimitDivergence(status, detachedLimits.values)
		: undefined;
	const lifecycleArtifact = runtime.getLifecycleArtifactStatus?.() ?? {
		enabled: false,
		version: 1,
	};
	return [
		`Delegation: ${workflowLabel(current)}`,
		`Completion: ${completionLabel(status.completionDelivery)}`,
		`Consult target: ${consultationCwdLabel(runtime.getConsultationCwdPolicy())}`,
		`Delegation target: ${delegationCwdLabel(runtime.getDelegationCwdPolicy())}`,
		`Consult resources: ${consultResourceLabel(runtime.getConsultResourcePolicy())}`,
		`Parallel workers: max ${runtime.getMaxParallelTasks()} per blocking call`,
		`Detached limits: ${formatDetachedLimitSummary(status)}`,
		`FleetView: ${fleetViewLabel(runtime.getFleetView?.() ?? "off")}`,
		`Lifecycle artifact: ${lifecycleArtifact.enabled ? "metadata" : "off"}`,
		`Configured consult target: ${consultationCwdLabel(cwdPolicy.consultation.value)} · ${cwdPolicy.consultation.source}`,
		`Configured delegation target: ${delegationCwdLabel(cwdPolicy.delegation.value)} · ${cwdPolicy.delegation.source}`,
		`Configured consult resources: ${consultResourceLabel(consult.value)} · ${consult.source}`,
		`Settings: ${safeTerminalText(cwdPolicy.path)}`,
		`Agents: ${status.activeAgents} active · ${status.retainedAgents} retained`,
		...(detachedDivergence ? [detachedDivergence] : []),
		...(configured.value !== current
			? [`Configured after reload: ${workflowLabel(configured.value)}`]
			: []),
		...(configured.error || detachedLimits.error
			? ["Settings need repair; open Advanced settings for details."]
			: []),
	].join("\n");
}

export function formatStatus(
	status: StatefulSubagentRuntimeStatus,
	snapshot: ReturnType<typeof inspectCompletionDeliverySettings>,
	runtime?: SubagentSettingsRuntime,
): string {
	const configuredWorkflow = inspectDelegationWorkflowSettings();
	const consult = inspectConsultResourceSettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const parallelLimit = inspectBlockingParallelLimitSettings();
	const detachedLimits = inspectStatefulLimitSettings();
	const current = runtime ? currentWorkflow(runtime, status) : configuredWorkflow.value;
	const fleetView = runtime?.getFleetView?.() ?? "off";
	const lifecycleArtifact = runtime?.getLifecycleArtifactStatus?.() ?? {
		enabled: false,
		version: 1,
	};
	return [
		"Current session",
		`  Delegation: ${workflowLabel(current)}`,
		`  Async runtime: ${status.initialized ? "initialized" : status.enabled ? "not initialized" : "disabled"}`,
		`  Transport: ${status.transport}`,
		`  Completion: ${completionLabel(status.completionDelivery)}`,
		`  Consultation target: ${consultationCwdLabel(runtime?.getConsultationCwdPolicy() ?? cwdPolicy.consultation.value)}`,
		`  Delegation target: ${delegationCwdLabel(runtime?.getDelegationCwdPolicy() ?? cwdPolicy.delegation.value)}`,
		`  Consultation resources: ${consultResourceLabel(runtime?.getConsultResourcePolicy() ?? consult.value)}`,
		`  Maximum parallel workers: ${runtime?.getMaxParallelTasks() ?? parallelLimit.value} per blocking call`,
		`  Detached limits: ${formatDetachedLimitSummary(status)}`,
		`  FleetView: ${fleetViewLabel(fleetView)}`,
		`  Lifecycle artifact: ${lifecycleArtifact.enabled ? "metadata" : "off"}`,
		...(lifecycleArtifact.path
			? [`  Lifecycle artifact path: ${safeTerminalText(lifecycleArtifact.path)}`]
			: []),
		...(lifecycleArtifact.error
			? [`  Lifecycle artifact warning: ${safeTerminalText(lifecycleArtifact.error)}`]
			: []),
		`  Agents: ${status.activeAgents} active, ${status.retainedAgents} retained`,
		"User settings",
		`  Delegation source: ${configuredWorkflow.source}`,
		`  Configured delegation: ${workflowLabel(configuredWorkflow.value)}`,
		`  Completion source: ${snapshot.source}`,
		`  Configured completion: ${completionLabel(snapshot.value)}`,
		`  Configured parallel limit: ${parallelLimit.value}`,
		`  Parallel limit source: ${parallelLimit.source}`,
		...(detachedLimits.values
			? STATEFUL_LIMIT_DEFINITIONS.map((definition) => {
					const configured = detachedLimits.values?.[definition.field];
					return `  Configured ${definition.label.toLowerCase()}: ${configured?.value} (${configured?.source})`;
				})
			: ["  Configured detached limits: unavailable"]),
		`  Configured consultation target: ${consultationCwdLabel(cwdPolicy.consultation.value)}`,
		`  Consultation target source: ${cwdPolicy.consultation.source}`,
		`  Configured delegation target: ${delegationCwdLabel(cwdPolicy.delegation.value)}`,
		`  Delegation target source: ${cwdPolicy.delegation.source}`,
		`  Configured consultation resources: ${consultResourceLabel(consult.value)}`,
		`  Consultation resource source: ${consult.source}`,
		`  Path: ${safeTerminalText(snapshot.path)}`,
		configuredWorkflow.error ||
		snapshot.error ||
		cwdPolicy.error ||
		parallelLimit.error ||
		detachedLimits.error
			? `  Warning: ${safeTerminalText(configuredWorkflow.error ?? snapshot.error ?? cwdPolicy.error ?? parallelLimit.error ?? detachedLimits.error ?? "invalid settings")}`
			: "  Warning: none",
		configuredWorkflow.value !== current
			? "Configured delegation differs from this session. Run /reload to apply it."
			: "Manual file changes require /reload.",
	].join("\n");
}

export function currentWorkflow(
	runtime: SubagentSettingsRuntime,
	status: StatefulSubagentRuntimeStatus,
): DelegationWorkflow {
	const blocking = runtime.getBlockingEnabled();
	if (blocking && status.enabled) return "all";
	if (status.enabled) return "async-only";
	if (blocking) return "blocking-only";
	return "disabled";
}

export function isWorkflow(value: string): value is Exclude<DelegationWorkflow, "disabled"> {
	return value === "all" || value === "async-only" || value === "blocking-only";
}

export function completionLabel(value: CompletionDelivery): string {
	return value === "auto-resume" ? "Resume automatically when finished" : "Wait until my next turn";
}

export function fleetViewLabel(value: FleetViewMode): string {
	return value === "active" ? "Show active agents" : "Off";
}

export function lifecycleArtifactLabel(value: LifecycleArtifactsMode): string {
	return value === "metadata" ? "Metadata after reload" : "Off";
}

export function consultationCwdLabel(value: ConsultationCwdPolicy): string {
	return value === "current-workspace"
		? "Current workspace only"
		: "Anywhere · untrusted targets inherit nothing";
}

export function delegationCwdLabel(value: DelegationCwdPolicy): string {
	switch (value) {
		case "trusted-targets":
			return "Current or saved-trusted folders";
		case "current-workspace":
			return "Current workspace only";
		case "anywhere":
			return "Anywhere · normal Pi permissions";
	}
}

export function consultResourceLabel(value: ConsultResourcePolicy): string {
	switch (value) {
		case "project-context":
			return "Project context only";
		case "none":
			return "No inherited resources";
		case "all":
			return "All trusted resources";
	}
}

export function formatError(error: unknown): string {
	return safeTerminalText(error instanceof Error ? error.message : String(error));
}
