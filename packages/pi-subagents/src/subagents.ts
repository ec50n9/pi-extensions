import { randomUUID } from "node:crypto";

/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentScope,
	type ConsultationCwdPolicy,
	type ConsultResourcePolicy,
	type DelegationCwdPolicy,
	discoverAgentCatalog,
	discoverAgents,
	formatAgentCatalog,
	isThinkingLevel,
	type SubagentSettings,
	type SubagentThinkingLevel,
} from "./agents.js";
import { CapabilityCeilingRegistry } from "./capability-ceiling.js";
import { registerSubagentConfigCommand, registerSubagentConfigLifecycle } from "./config-ui.js";
import { registerSubagentConsult } from "./consult.js";
import {
	assertDelegationTargetAllowed,
	resolveSubagentTarget,
	targetPolicyAudit,
} from "./cwd-policy.js";
import type { EvidencePolicy } from "./evidence.js";
import { executeSubagent, resolveDefaultSubagentTimeoutMs } from "./execution.js";
import { registerSubagentInspect } from "./inspect.js";
import { resolveLaunchContract } from "./launch-contract.js";
import {
	DEFAULT_MAX_CONTEXT_BYTES,
	MAX_BLOCKING_PARALLEL_CONCURRENCY,
	MAX_SUBAGENT_TIMEOUT_MS,
} from "./limits.js";
import { SubagentParams } from "./params.js";
import { registerPiSubagentsV1Api } from "./public-api.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import type { SubagentDetails } from "./runner.js";
import {
	consumeSubagentSettingsNotice,
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
	DEFAULT_DELEGATION_CWD_POLICY,
	inspectSubagentSettings,
	readSubagentSettings,
	resolveBlockingMaxParallelTasks,
	resolveSubagentThinkingLevel,
} from "./settings.js";
import { registerStatefulSubagents } from "./stateful.js";

export default function (pi: ExtensionAPI) {
	const configOwner = registerSubagentConfigLifecycle(pi);
	const ceilings = new CapabilityCeilingRegistry();
	const settings = readSubagentSettings();
	let currentSettings: SubagentSettings | undefined = settings;
	let currentCatalog = "";
	const blockingEnabled = settings?.blocking?.enabled !== false;
	const refreshBlockingCatalog = blockingEnabled
		? registerBlockingSubagent(pi, () => currentSettings, ceilings)
		: () => undefined;
	let refreshStatefulCatalog: (catalog: string) => void = () => undefined;
	let refreshConsultCatalog: (catalog: string) => void = () => undefined;

	pi.on("session_start", (_event, ctx) => {
		// Preserve a one-shot migration notice from extension load while refreshing
		// validation against settings that may have changed before this session.
		const loadNotice = consumeSubagentSettingsNotice();
		const refreshedSettings = readSubagentSettings();
		const refreshedNotice = consumeSubagentSettingsNotice();
		if (!inspectSubagentSettings().error) currentSettings = refreshedSettings;
		const notice = [
			...new Set([loadNotice, refreshedNotice].filter((value) => value !== undefined)),
		].join("\n");
		if (notice) ctx.ui.notify(notice, "warning");

		currentCatalog = formatAgentCatalog(
			discoverAgentCatalog(ctx.cwd, ctx.isProjectTrusted(), refreshedSettings),
		).text;
		refreshBlockingCatalog(currentCatalog);
		refreshStatefulCatalog(currentCatalog);
		refreshConsultCatalog(currentCatalog);
	});

	let deactivatePublicApi: () => void = () => undefined;
	// Pi awaits shutdown handlers in registration order, so stop new API work before agent cleanup.
	pi.on("session_shutdown", () => deactivatePublicApi());
	const statefulRuntime = registerStatefulSubagents(pi, {
		blockingEnabled,
		settings: settings?.stateful,
		getSettings: () => currentSettings,
		ceilings,
	});
	refreshStatefulCatalog = statefulRuntime.setAgentCatalog;
	deactivatePublicApi = registerPiSubagentsV1Api(pi, ceilings, {
		preflight: (payload, ctx) => ({
			...preflightPublicDelegation(payload, ctx, currentSettings, ceilings),
			lifecycleArtifact: statefulRuntime.getLifecycleArtifactStatus(),
		}),
		delegate: async (payload, signal, ctx) => {
			const request = parsePublicDelegation(payload, true);
			const requestedAgent = discoverAgents(
				ctx.cwd,
				request.agentScope,
				currentSettings,
			).agents.find((agent) => agent.name === request.agent);
			if (requestedAgent?.source === "project" && request.confirmProjectAgents && !ctx.hasUI) {
				throw new Error(
					"Project-local subagent confirmation requires UI; set confirmProjectAgents to false explicitly only in a trusted project",
				);
			}
			return executeSubagent(
				`public:${randomUUID()}`,
				{
					agent: request.agent,
					task: request.task,
					cwd: request.cwd,
					agentScope: request.agentScope,
					thinkingLevel: request.thinkingLevel,
					timeoutMs: request.timeoutMs,
					evidence: request.evidence,
					confirmProjectAgents: request.confirmProjectAgents,
				},
				signal,
				undefined,
				ctx,
				currentSettings,
				ceilings,
			);
		},
		status: () => ({
			...statefulRuntime.getRuntimeStatus(),
			fleetView: statefulRuntime.getFleetView(),
			lifecycleArtifact: statefulRuntime.getLifecycleArtifactStatus(),
		}),
	});
	const getBlockingEnabled = () => blockingEnabled;
	const getMaxParallelTasks = () => resolveBlockingMaxParallelTasks(currentSettings);
	const getConsultResourcePolicy = () =>
		currentSettings?.consult?.resources ?? DEFAULT_CONSULT_RESOURCE_POLICY;
	const getConsultationCwdPolicy = () =>
		currentSettings?.cwdPolicy?.consultation ?? DEFAULT_CONSULTATION_CWD_POLICY;
	const getDelegationCwdPolicy = () =>
		currentSettings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY;
	registerSubagentInspect(pi, {
		...statefulRuntime,
		getBlockingEnabled,
		getMaxParallelTasks,
		getConsultResourcePolicy,
		getConsultationCwdPolicy,
		getDelegationCwdPolicy,
	});
	if (blockingEnabled) {
		refreshConsultCatalog = registerSubagentConsult(pi, {
			getSettings: () => currentSettings,
			ceilings,
		});
	}
	registerSubagentConfigCommand(
		pi,
		{
			...statefulRuntime,
			getBlockingEnabled,
			getMaxParallelTasks,
			getConsultResourcePolicy,
			getConsultationCwdPolicy,
			getDelegationCwdPolicy,
			setMaxParallelTasks(value: number) {
				const previousSettings = currentSettings;
				currentSettings = {
					...(currentSettings ?? {}),
					blocking: { ...(currentSettings?.blocking ?? {}), maxParallelTasks: value },
				};
				try {
					refreshBlockingCatalog(currentCatalog);
				} catch (applyError) {
					currentSettings = previousSettings;
					try {
						refreshBlockingCatalog(currentCatalog);
					} catch (rollbackError) {
						throw new AggregateError(
							[applyError, rollbackError],
							"Failed to apply and roll back the parallel-worker limit",
						);
					}
					throw applyError;
				}
			},
			setConsultResourcePolicy(value: ConsultResourcePolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					consult: { ...(currentSettings?.consult ?? {}), resources: value },
				};
				refreshConsultCatalog(currentCatalog);
			},
			setConsultationCwdPolicy(value: ConsultationCwdPolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					cwdPolicy: { ...(currentSettings?.cwdPolicy ?? {}), consultation: value },
				};
				refreshConsultCatalog(currentCatalog);
			},
			setDelegationCwdPolicy(value: DelegationCwdPolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					cwdPolicy: { ...(currentSettings?.cwdPolicy ?? {}), delegation: value },
				};
				refreshBlockingCatalog(currentCatalog);
				statefulRuntime.refreshSettingsGuidance();
			},
		},
		configOwner,
	);
}

interface PublicLeafDelegation {
	agent: string;
	task: string;
	cwd?: string;
	agentScope: AgentScope;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs?: number;
	evidence?: EvidencePolicy;
	confirmProjectAgents: boolean;
}

function parsePublicDelegation(payload: unknown, requireTask: boolean): PublicLeafDelegation {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Delegation payload must be an object");
	}
	const value = payload as Record<string, unknown>;
	const allowed = new Set([
		"agent",
		"task",
		"cwd",
		"agentScope",
		"thinkingLevel",
		"timeoutMs",
		"evidence",
		"confirmProjectAgents",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw new Error("Delegation payload contains an unsupported field");
	}
	if (
		typeof value.agent !== "string" ||
		!value.agent.trim() ||
		value.agent.length > 256 ||
		value.agent.includes("\0")
	) {
		throw new Error("agent must be a non-empty bounded string");
	}
	if (
		requireTask &&
		(typeof value.task !== "string" ||
			!value.task.trim() ||
			Buffer.byteLength(value.task, "utf8") > DEFAULT_MAX_CONTEXT_BYTES)
	) {
		throw new Error("task must be a non-empty bounded string");
	}
	if (!requireTask && value.task !== undefined) {
		throw new Error("preflight does not accept task");
	}
	if (value.task !== undefined && typeof value.task !== "string") {
		throw new Error("task must be a string");
	}
	if (typeof value.task === "string" && value.task.includes("\0")) {
		throw new Error("task must not contain NUL bytes");
	}
	if (
		value.cwd !== undefined &&
		(typeof value.cwd !== "string" ||
			!value.cwd.trim() ||
			value.cwd.length > 4096 ||
			value.cwd.includes("\0"))
	) {
		throw new Error("cwd must be a non-empty bounded string");
	}
	const scope = value.agentScope ?? "user";
	if (scope !== "user" && scope !== "project" && scope !== "both") {
		throw new Error("agentScope must be user, project, or both");
	}
	if (value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel)) {
		throw new Error("thinkingLevel is invalid");
	}
	if (
		value.timeoutMs !== undefined &&
		(typeof value.timeoutMs !== "number" ||
			!Number.isFinite(value.timeoutMs) ||
			value.timeoutMs < 1 ||
			value.timeoutMs > MAX_SUBAGENT_TIMEOUT_MS)
	) {
		throw new Error("timeoutMs is outside the supported range");
	}
	if (value.evidence !== undefined && value.evidence !== "attested") {
		throw new Error("evidence must be attested when provided");
	}
	if (value.confirmProjectAgents !== undefined && typeof value.confirmProjectAgents !== "boolean") {
		throw new Error("confirmProjectAgents must be boolean");
	}
	return {
		agent: value.agent,
		task: typeof value.task === "string" ? value.task : "",
		cwd: value.cwd as string | undefined,
		agentScope: scope,
		thinkingLevel: value.thinkingLevel as SubagentThinkingLevel | undefined,
		timeoutMs: value.timeoutMs as number | undefined,
		evidence: value.evidence as EvidencePolicy | undefined,
		confirmProjectAgents: value.confirmProjectAgents !== false,
	};
}

function preflightPublicDelegation(
	payload: unknown,
	ctx: ExtensionContext,
	settings: SubagentSettings | undefined,
	ceilings: CapabilityCeilingRegistry,
) {
	const request = parsePublicDelegation(payload, false);
	if (
		(request.agentScope === "project" || request.agentScope === "both") &&
		!ctx.isProjectTrusted()
	) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
	const discovery = discoverAgents(ctx.cwd, request.agentScope, settings);
	const agent = discovery.agents.find((candidate) => candidate.name === request.agent);
	if (!agent) throw new Error(`Unknown agent: ${request.agent}`);
	const target = resolveSubagentTarget({
		workspace: ctx.cwd,
		requestedCwd: request.cwd,
		currentProjectTrusted: ctx.isProjectTrusted(),
	});
	assertDelegationTargetAllowed(
		target,
		settings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY,
	);
	const contract = resolveLaunchContract({
		agent,
		agentScope: request.agentScope,
		target: targetPolicyAudit(target),
		thinkingLevel: resolveSubagentThinkingLevel(
			discovery.agents,
			request.agent,
			request.thinkingLevel,
		),
		timeoutMs: request.timeoutMs ?? agent.timeoutMs ?? resolveDefaultSubagentTimeoutMs(),
		transport: "subprocess",
		evidence: request.evidence,
		ceiling: ceilings.resolve(),
	});
	return {
		...contract,
		projectAgentConfirmationRequired: agent.source === "project" && request.confirmProjectAgents,
	};
}

function registerBlockingSubagent(
	pi: ExtensionAPI,
	getSettings: () => SubagentSettings | undefined,
	ceilings: CapabilityCeilingRegistry,
): (catalog: string) => void {
	let catalog = "";
	const baseDescription = () =>
		[
			"Run specialized subagents as a blocking operation with isolated contexts.",
			"The call blocks the main agent until every worker and optional aggregator finishes, so queued steering waits.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Parallel mode may include an aggregator fan-in step that receives all task outputs. Use subagent_consult instead for one synchronous child that must be executor-constrained to read-only tools.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, pass agentScope: "both" (or "project") as a top-level argument for that call.`,
			`Maximum parallel worker tasks per call: ${resolveBlockingMaxParallelTasks(getSettings())}. Parallel execution starts at most ${MAX_BLOCKING_PARALLEL_CONCURRENCY} workers at once.`,
			`Working-directory target policy: ${getSettings()?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY}. This controls launch targets and protected project resources, not filesystem access or sandboxing.`,
		].join(" ");
	const promptGuidelines = () => [
		"Use subagent only when delegation fits; the main agent should decide how many subagents to spawn from task shape instead of waiting for the user to specify a count.",
		"Use no subagent for simple answers, quick targeted edits, latency-sensitive one-step work, tasks requiring frequent user back-and-forth, or critical-path work the main agent can perform directly.",
		"Use the blocking subagent tool only when delegated outputs are required before the main agent's next action and waiting is intentional; the main agent cannot process queued steering until the call returns.",
		"Use a blocking subagent single, parallel, chain, or fan-in call only when synchronous context or output isolation is worth making the main agent unavailable while it runs.",
		`If a blocking parallel subagent call is genuinely required, keep tasks independent, stay within the configured max ${resolveBlockingMaxParallelTasks(getSettings())}, and avoid write-heavy implementation touching the same files or shared state.`,
		"For parallel subagent calls, omit the aggregator key entirely unless a fan-in step is required; do not send null, empty strings, or an empty object for unused optional fields.",
		'Do not use subagent with project-local agents unless the user explicitly wants project agents or sets agentScope to "project" or "both"; keep confirmation enabled for untrusted repositories.',
		"When using subagent, write self-contained tasks with file paths, context, expected output, and whether the subagent may edit files.",
	];
	const definition: ToolDefinition<typeof SubagentParams, SubagentDetails> = {
		name: "subagent",
		label: "Blocking Subagent",
		description: appendAgentCatalog(baseDescription(), catalog),
		promptSnippet:
			"Run blocking isolated subagents only when their outputs are required before the main agent can continue.",
		promptGuidelines: promptGuidelines(),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagent(toolCallId, params, signal, onUpdate, ctx, getSettings(), ceilings);
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},
	};
	pi.registerTool<typeof SubagentParams, SubagentDetails>(definition);
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		if ((event.details as (SubagentDetails & { isError?: boolean }) | undefined)?.isError)
			return { isError: true };
	});
	return (nextCatalog: string) => {
		catalog = nextCatalog;
		definition.description = appendAgentCatalog(baseDescription(), catalog);
		definition.promptGuidelines = promptGuidelines();
		pi.registerTool<typeof SubagentParams, SubagentDetails>(definition);
	};
}

function appendAgentCatalog(baseDescription: string, catalog: string): string {
	return catalog ? `${baseDescription}\n\n${catalog}` : baseDescription;
}

export { parsePositiveInteger } from "./execution.js";
export { formatTokens, formatUsageStats } from "./render.js";
export { buildPiArgs } from "./runner.js";
export {
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
	DEFAULT_DELEGATION_CWD_POLICY,
	inspectBlockingParallelLimitSettings,
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	inspectFleetViewSettings,
	inspectLifecycleArtifactSettings,
	inspectStatefulLimitSettings,
	inspectSubagentSettings,
	normalizeAgentSettings,
	normalizeSubagentSettings,
	readSubagentSettings,
	resolveBlockingMaxParallelTasks,
	resolveSubagentThinkingLevel,
	sameToolSet,
	saveSubagentConfig,
	subagentSettingsFilePath,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateBlockingMaxParallelTasksSetting,
	updateCompletionDeliverySetting,
	updateConsultResourceSetting,
	updateCwdPolicySetting,
	updateDelegationWorkflowSetting,
	updateFleetViewSetting,
	updateLifecycleArtifactSetting,
	updateStatefulLimitSetting,
} from "./settings.js";
