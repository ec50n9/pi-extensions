/**
 * Blocking execution stays in one module so preflight, confirmation, cancellation generation,
 * launch, and settlement retain one ordered lifecycle owner across every mode.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdaptiveScheduler } from "./adaptive-scheduler.js";
import { evaluateDelegationAdmission } from "./admission-policy.js";
import { discoverAgents } from "./agents/discovery.js";
import type {
	AgentConfig,
	AgentScope,
	SubagentSettings,
	SubagentThinkingLevel,
} from "./agents/types.js";
import {
	chainStatus,
	fanInStatus,
	parallelStatus,
	singleStatus,
	startSubagentStatus,
} from "./blocking-status.js";
import { issueCapabilityGrant, revokeCapabilityGrant } from "./capability-grant.js";
import { redactPrivateText } from "./context.js";
import {
	assertDelegationTargetAllowed,
	type ResolvedSubagentTarget,
	resolveSubagentTarget,
	targetPolicyAudit,
} from "./cwd-policy.js";
import {
	appendDelegationContract,
	type DelegationContract,
	normalizeDelegationContract,
} from "./delegation-contract.js";
import {
	calculateExecutionBudget,
	mergeTurnLimits,
	resolveConfiguredTimeout,
} from "./execution/budget.js";
import {
	assertSubagentDepthAllowed,
	resolveDefaultSubagentTimeoutMs,
} from "./execution/runtime-policy.js";
import {
	acknowledgeExecutionPlan,
	createExecutionPlan,
	resolveContractTools,
} from "./execution-plan.js";
import {
	DEFAULT_MAX_CONTEXT_BYTES,
	DEFAULT_MAX_OUTPUT_BYTES,
	MAX_BLOCKING_PARALLEL_CONCURRENCY,
	MAX_SUBAGENT_TIMEOUT_MS,
	truncateUtf8,
} from "./limits.js";
import { calculateOrchestrationMetrics } from "./orchestration-metrics.js";
import { executePanel, preflightPanelExecution } from "./panel-execution.js";
import { validatePanelRequest } from "./panel-planning.js";
import { hasUsableAggregator, type SubagentParams } from "./params.js";
import { appendResultInstruction, type SubagentResultFormat } from "./result-contract.js";
import {
	buildFanInContext,
	formatResultFailure,
	getResultFinalOutput,
	isResultError,
	mapWithConcurrencyLimit,
	type OnUpdateCallback,
	runSingleAgent,
	type SingleResult,
	type SubagentDetails,
} from "./runner.js";
import { safeTerminalLine } from "./safe-text.js";
import {
	DEFAULT_DELEGATION_CWD_POLICY,
	resolveBlockingMaxParallelTasks,
} from "./settings/inspection.js";
import { readSubagentSettings, resolveSubagentThinkingLevel } from "./settings.js";
import { isRetryableResult, runHedgedAttempt, supervisionDelay } from "./supervision.js";
import { TimeoutProgressJournal, TURN_TERMINATION_VERSION } from "./timeout-checkpoint.js";
import type { TurnLimits } from "./turn-budget.js";
import {
	requiresIndependentVerification,
	validateWorkflowVerificationGraph,
} from "./verification-policy.js";
import { prepareVerifiedWorkflow } from "./verified-execution-contract.js";
import type { WorkItemLedger } from "./work-item-ledger.js";
import {
	createSessionWorkItemPersistence,
	type WorkItemPersistence,
} from "./work-item-persistence.js";
import {
	WorkflowCompletionController,
	workflowCompletionFailureReason,
} from "./workflow-completion-controller.js";
import { createBlockingWorkLedger, resolveWorkflowTasks } from "./workflow-planning.js";
import { captureWorkflowTreeIdentity, sameWorkflowTreeIdentity } from "./workflow-tree-identity.js";
import {
	createWorkflowVerificationReceipt,
	workflowVerificationInstruction,
} from "./workflow-verification.js";

export {
	assertSubagentDepthAllowed,
	FALLBACK_TIMEOUT_MS,
	parsePositiveInteger,
	resolveDefaultSubagentTimeoutMs,
} from "./execution/runtime-policy.js";

export async function executeSubagent(
	toolCallId: string,
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
	ctx: ExtensionContext,
	settingsOverride?: SubagentSettings,
): Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }> {
	assertSubagentDepthAllowed();
	const agentScope: AgentScope = params.agentScope ?? "user";
	if ((agentScope === "project" || agentScope === "both") && !ctx.isProjectTrusted()) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
	const aggregator = hasUsableAggregator(params.aggregator) ? params.aggregator : undefined;
	const config = settingsOverride ?? readSubagentSettings();
	const maxParallelTasks = resolveBlockingMaxParallelTasks(config);
	const discovery = discoverAgents(ctx.cwd, agentScope, config);
	const agents = discovery.agents;
	let resolvedWorkflowTasks = resolveWorkflowTasks(params, agents);
	const verifiedWorkflow = params.workflow?.verifiedExecution
		? prepareVerifiedWorkflow(resolvedWorkflowTasks, params.workflow.verifiedExecution)
		: undefined;
	if (verifiedWorkflow) {
		const verifierAgent = agents.find(
			(agent) => agent.name === params.workflow?.verifiedExecution?.verifierAgent,
		);
		if (!verifierAgent) {
			throw new Error(
				`Unknown verified execution agent: ${params.workflow?.verifiedExecution?.verifierAgent}`,
			);
		}
		if (
			!verifierAgent.capabilityManifest?.verificationRoles.includes("independent-review") ||
			!verifierAgent.capabilityManifest.resultFormats.includes("structured-v2")
		) {
			throw new Error(
				`Verified execution agent ${verifierAgent.name} lacks independent structured-v2 review capability`,
			);
		}
		resolvedWorkflowTasks = verifiedWorkflow.tasks;
	}
	const confirmProjectAgents = params.confirmProjectAgents ?? true;
	const resolveTimeoutMs = (agentName: string, localTimeoutMs?: number) =>
		resolveConfiguredTimeout(
			agents,
			agentName,
			localTimeoutMs,
			params.timeoutMs,
			resolveDefaultSubagentTimeoutMs(),
		);
	const resolveThinkingLevel = (agentName: string, localThinkingLevel?: SubagentThinkingLevel) =>
		resolveSubagentThinkingLevel(agents, agentName, params.thinkingLevel, localThinkingLevel);
	let orchestrationDeadline: number | undefined;
	const resolveTurnLimits = (local?: TurnLimits): TurnLimits =>
		mergeTurnLimits(local, {
			idleTimeoutMs: params.idleTimeoutMs,
			maxTurns: params.maxTurns,
			maxToolCalls: params.maxToolCalls,
		});
	const resolveExecutionBudget = (agentName: string, localTimeoutMs?: number) =>
		calculateExecutionBudget({
			requestedTimeoutMs: resolveTimeoutMs(agentName, localTimeoutMs),
			orchestrationDeadline,
			totalTimeoutMs: params.totalTimeoutMs,
			now: Date.now(),
		});

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasWorkflow = (params.workflow?.tasks.length ?? 0) > 0;
	const hasPanel = params.panel !== undefined;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount =
		Number(hasChain) +
		Number(hasTasks) +
		Number(hasWorkflow) +
		Number(hasPanel) +
		Number(hasSingle);
	let workLedger: WorkItemLedger | undefined;
	const workflowScheduling: ReturnType<AdaptiveScheduler["decide"]>[] = [];
	const verificationTargetIds = new Set<string>();

	const makeDetails =
		(mode: "single" | "parallel" | "chain" | "workflow" | "panel") =>
		(results: SingleResult[], aggregator?: SingleResult): SubagentDetails => {
			const workflow = workLedger?.snapshot();
			const metricResults = aggregator ? [...results, aggregator] : results;
			return {
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
				aggregator,
				workflow,
				schedulerDecisions:
					workflowScheduling.length > 0 ? workflowScheduling.slice(-64) : undefined,
				metrics: calculateOrchestrationMetrics(workflow, metricResults),
			};
		};
	const workflowFailureResult = (
		agentName: string,
		task: string,
		reasonCode: string,
		message: string,
		thinkingLevel?: SubagentThinkingLevel,
	): SingleResult => ({
		agent: agentName,
		agentSource: agents.find((agent) => agent.name === agentName)?.source ?? "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		errorMessage: message,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		thinkingLevel,
		finalOutput: "",
		outcome: {
			status: "failed",
			reasonCode,
			recoveryActions: ["revalidate"],
			retryable: false,
		},
	});
	const exhaustedResult = (
		agentName: string,
		task: string,
		thinkingLevel: SubagentThinkingLevel | undefined,
		step?: number,
	): SingleResult => {
		const limit = Math.floor(params.totalTimeoutMs as number);
		const message = `Subagent orchestration deadline expired after ${limit}ms`;
		return {
			agent: agentName,
			agentSource: agents.find((agent) => agent.name === agentName)?.source ?? "unknown",
			task,
			exitCode: 124,
			messages: [],
			stderr: message,
			errorMessage: message,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			thinkingLevel,
			step,
			finalOutput: "",
			timedOut: true,
			stopReason: "timeout",
			termination: {
				version: TURN_TERMINATION_VERSION,
				reason: "orchestration_timeout",
				limit,
				checkpoint: new TimeoutProgressJournal().checkpoint(task),
				finalization: { attempted: false, status: "skipped", durationMs: 0 },
			},
		};
	};

	if (modeCount !== 1 || (aggregator && !hasTasks)) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		const reason =
			modeCount !== 1
				? "Provide exactly one mode."
				: "Aggregator is only valid with parallel tasks.";
		return {
			content: [
				{
					type: "text",
					text: `Invalid parameters. ${reason}\nAvailable agents: ${available}`,
				},
			],
			details: makeDetails("single")([]),
		};
	}
	if (
		(hasWorkflow || hasPanel) &&
		(Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) > 0
	) {
		throw new Error("Explicit workflow and panel recursion is disabled until separately evaluated");
	}
	if (params.panel) {
		validatePanelRequest(params.panel, maxParallelTasks);
		for (const agentName of [
			...params.panel.reviewers.map((reviewer) => reviewer.agent),
			params.panel.synthesizer.agent,
		]) {
			if (!agents.some((agent) => agent.name === agentName)) {
				throw new Error(`Unknown panel agent: ${agentName}`);
			}
		}
	}
	if (
		(hasTasks && (params.tasks?.length ?? 0) > maxParallelTasks) ||
		(hasWorkflow && (params.workflow?.tasks.length ?? 0) > maxParallelTasks) ||
		(hasPanel && (params.panel?.reviewers.length ?? 0) > maxParallelTasks)
	) {
		const count = hasWorkflow
			? (params.workflow?.tasks.length ?? 0)
			: hasPanel
				? (params.panel?.reviewers.length ?? 0)
				: (params.tasks?.length ?? 0);
		throw new Error(`Too many delegated tasks (${count}). Configured max is ${maxParallelTasks}.`);
	}

	const nonWorkflowRetryConfigured =
		!hasWorkflow &&
		Boolean(
			params.retryPolicy ||
				params.hedgeAfterMs ||
				params.tasks?.some((task) => task.retryPolicy || task.hedgeAfterMs) ||
				params.chain?.some((task) => task.retryPolicy || task.hedgeAfterMs) ||
				aggregator?.retryPolicy ||
				aggregator?.hedgeAfterMs,
		);
	if (nonWorkflowRetryConfigured) {
		throw new Error("Retry and hedge policies are supported only by explicit workflow tasks");
	}
	if (hasWorkflow && params.workflow) {
		for (const task of resolvedWorkflowTasks) {
			if (task.verifierFor) verificationTargetIds.add(task.verifierFor);
			const contract = normalizeDelegationContract(task.contract);
			if (params.workflow.honorAdmission) {
				const admission = contract?.admission;
				const decision = evaluateDelegationAdmission({
					contextPressure: admission?.contextPressure ?? "low",
					independentWorkItems: admission?.independentWorkItems ?? 1,
					coupling: admission?.coupling ?? "dense",
					verificationRequired: admission?.verificationRequired ?? false,
					verificationAvailable: admission?.verificationAvailable ?? false,
					capabilitiesSupported: true,
					budgetAllowsChildren: admission?.budgetAllowsChildren ?? false,
					generationCurrent: true,
					requirementsComplete: admission?.requirementsComplete ?? false,
				});
				if (
					decision.recommendation === "parent-owned-direct" ||
					decision.recommendation === "abstain-insufficient-evidence"
				) {
					throw new Error(
						`Admission declined workflow task ${task.id}: ${decision.reasonCodes.join(", ")}`,
					);
				}
			}
			if (
				requiresIndependentVerification({
					contract,
					integrationOwner: task.integrationOwner === true,
					requiredCapabilities: task.requiredCapabilities ?? [],
				})
			) {
				verificationTargetIds.add(task.id);
			}
			if (!task.retryPolicy && !task.hedgeAfterMs) continue;
			const policy = contract?.sideEffectPolicy;
			if (
				(task.retryPolicy && policy !== "read-only" && policy !== "idempotent") ||
				(task.hedgeAfterMs && policy !== "read-only")
			) {
				throw new Error(
					`Workflow task ${task.id} must declare an idempotent retry or read-only hedge delegation contract`,
				);
			}
		}
		validateWorkflowVerificationGraph(
			resolvedWorkflowTasks.map((task) => ({
				...task,
				resultFormat: task.resultFormat ?? params.resultFormat,
			})),
			verificationTargetIds,
		);
	}
	workLedger = createBlockingWorkLedger(
		params,
		resolvedWorkflowTasks,
		aggregator,
		verifiedWorkflow
			? {
					id: verifiedWorkflow.targetTaskId,
					maxReworkCycles: verifiedWorkflow.maxReworkCycles,
				}
			: undefined,
	);
	let workflowPersistence: WorkItemPersistence | undefined;
	if (hasWorkflow && workLedger) {
		const owner =
			ctx.sessionManager.getSessionId?.() ??
			ctx.sessionManager.getSessionFile?.() ??
			`ephemeral:${ctx.cwd}`;
		workflowPersistence = createSessionWorkItemPersistence(owner, workLedger.workflowId);
	}
	const persistWorkLedger = async () => {
		if (workflowPersistence && workLedger) await workflowPersistence.save(workLedger.snapshot());
	};

	const delegationPolicy = config?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY;
	const resolveTarget = (cwd: string | undefined): ResolvedSubagentTarget => {
		const target = resolveSubagentTarget({
			workspace: ctx.cwd,
			requestedCwd: cwd,
			currentProjectTrusted: ctx.isProjectTrusted(),
		});
		assertDelegationTargetAllowed(target, delegationPolicy);
		return target;
	};
	const singleTarget = hasSingle ? resolveTarget(params.cwd) : undefined;
	const panelTarget = hasPanel ? resolveTarget(undefined) : undefined;
	const chainTargets = params.chain?.map((step) => resolveTarget(step.cwd)) ?? [];
	const parallelTargets = params.tasks?.map((task) => resolveTarget(task.cwd)) ?? [];
	const workflowTargets = resolvedWorkflowTasks.map((task) => resolveTarget(task.cwd));
	const aggregatorTarget = aggregator ? resolveTarget(aggregator.cwd) : undefined;
	if (params.panel && panelTarget) {
		await preflightPanelExecution({
			panel: params.panel,
			agents,
			signal,
			target: panelTarget,
			resolveThinkingLevel,
			resolveTimeoutMs,
		});
	}
	const attachTarget = (result: SingleResult, target: ResolvedSubagentTarget): SingleResult => {
		result.target = targetPolicyAudit(target);
		return result;
	};
	type ContractRequest = {
		contract?: unknown;
		resultFormat?: SubagentResultFormat;
	};
	const prepareTask = (task: string, local?: ContractRequest) => {
		const contracted = appendDelegationContract(task, local?.contract ?? params.contract);
		const resultFormat = local?.resultFormat ?? params.resultFormat;
		return {
			text: appendResultInstruction(contracted.text, resultFormat, DEFAULT_MAX_CONTEXT_BYTES),
			contract: contracted.contract,
			resultFormat,
		};
	};
	const launchPolicy = (
		target: ResolvedSubagentTarget,
		prepared: { contract?: DelegationContract; resultFormat?: SubagentResultFormat },
		displayTask: string,
		agentName: string,
		thinkingLevel: SubagentThinkingLevel | undefined,
		timeoutMs: number,
		taskGeneration = 0,
		budget?: NonNullable<ReturnType<typeof resolveExecutionBudget>>,
		turnLimits?: TurnLimits,
	) => {
		const agent = agents.find((candidate) => candidate.name === agentName);
		const effectiveTools = agent ? resolveContractTools(agent.tools, prepared.contract) : undefined;
		const executionPlan = agent
			? createExecutionPlan({
					contract: prepared.contract,
					agent,
					effectiveTools,
					target: targetPolicyAudit(target),
					workspaceMode: "shared",
					transport: "subprocess",
					resultFormat: prepared.resultFormat ?? "text",
					model: agent.model,
					thinkingLevel,
					timeoutMs,
					taskGeneration,
				})
			: undefined;
		if (executionPlan) {
			const acknowledgement = acknowledgeExecutionPlan(executionPlan);
			if (acknowledgement.status === "rejected") {
				throw new Error(`Execution plan rejected: ${JSON.stringify(acknowledgement)}`);
			}
		}
		const capabilityGrant = executionPlan
			? issueCapabilityGrant(executionPlan, Date.now(), Math.max(1, timeoutMs + 60_000))
			: undefined;
		return {
			projectTrust: target.trust.projectTrusted,
			turnLimits,
			workTimeoutReason: budget?.workTimeoutReason,
			workTimeoutReportLimit: budget?.workTimeoutReportLimit,
			orchestrationDeadlineAt: budget ? orchestrationDeadline : undefined,
			tools: effectiveTools,
			contract: prepared.contract,
			resultFormat: prepared.resultFormat,
			displayTask,
			executionPlan,
			capabilityGrant,
		};
	};

	// Build and acknowledge every contracted plan before confirmation or child launch.
	if (hasSingle && singleTarget && params.agent && params.task) {
		const prepared = prepareTask(params.task, params);
		launchPolicy(
			singleTarget,
			prepared,
			params.task,
			params.agent,
			resolveThinkingLevel(params.agent, params.thinkingLevel),
			resolveTimeoutMs(params.agent, params.timeoutMs),
		);
	}
	for (const [index, step] of (params.chain ?? []).entries()) {
		const prepared = prepareTask(step.task, step);
		launchPolicy(
			chainTargets[index],
			prepared,
			step.task,
			step.agent,
			resolveThinkingLevel(step.agent, step.thinkingLevel),
			resolveTimeoutMs(step.agent, step.timeoutMs),
		);
	}
	for (const [index, task] of (params.tasks ?? []).entries()) {
		const prepared = prepareTask(task.task, task);
		launchPolicy(
			parallelTargets[index],
			prepared,
			task.task,
			task.agent,
			resolveThinkingLevel(task.agent, task.thinkingLevel),
			resolveTimeoutMs(task.agent, task.timeoutMs),
		);
	}
	for (const [index, task] of resolvedWorkflowTasks.entries()) {
		const prepared = prepareTask(task.task, task);
		launchPolicy(
			workflowTargets[index],
			prepared,
			task.task,
			task.agent,
			resolveThinkingLevel(task.agent, task.thinkingLevel),
			resolveTimeoutMs(task.agent, task.timeoutMs),
			workLedger?.get(task.id)?.taskGeneration ?? 0,
		);
	}
	if (aggregator && aggregatorTarget) {
		const prepared = prepareTask(aggregator.task, aggregator);
		launchPolicy(
			aggregatorTarget,
			prepared,
			aggregator.task,
			aggregator.agent,
			resolveThinkingLevel(aggregator.agent, aggregator.thinkingLevel),
			resolveTimeoutMs(aggregator.agent, aggregator.timeoutMs),
		);
	}

	const artifactsFromResult = (result: SingleResult) => {
		const structured =
			result.structuredResult?.version === "pi-subagents:result:v2"
				? result.structuredResult
				: undefined;
		return (structured?.artifacts ?? []).map((artifact) => ({
			id: artifact.id,
			kind: artifact.kind,
			version: artifact.version ?? artifact.digest ?? "unversioned",
			digest: artifact.digest,
			verified: false,
		}));
	};
	const startWorkItem = (id: string, agentName: string) => {
		if (workLedger?.get(id)?.state === "ready") {
			return workLedger.start(id, `agent:${agentName}`);
		}
		return workLedger?.get(id);
	};
	const settleWorkItem = (id: string, result: SingleResult, taskGeneration: number) => {
		if (!workLedger) return;
		if (workLedger.get(id)?.taskGeneration !== taskGeneration) {
			result.outcome = {
				status: "stale",
				reasonCode: "stale-task-generation",
				recoveryActions: ["discard", "replan"],
				retryable: false,
			};
		}
		if (result.outcome?.status === "stale") {
			workLedger.invalidate(id, result.outcome.reasonCode ?? "stale-result");
			return;
		}
		if (isResultError(result)) {
			const state =
				result.outcome?.status === "blocked"
					? "blocked"
					: result.outcome?.status === "needs-input"
						? "needs-input"
						: result.aborted || result.outcome?.status === "interrupted"
							? "interrupted"
							: "failed";
			workLedger.settle(
				id,
				state,
				result.outcome?.reasonCode ?? result.errorMessage ?? result.stopReason,
			);
			return;
		}
		workLedger.complete(id, {
			taskGeneration,
			executionPlanId: result.executionPlan?.id,
			artifacts: artifactsFromResult(result),
		});
	};

	if (agentScope === "project" || agentScope === "both") {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		for (const task of resolvedWorkflowTasks) requestedAgentNames.add(task.agent);
		if (aggregator) requestedAgentNames.add(aggregator.agent);
		if (params.panel) {
			for (const reviewer of params.panel.reviewers) requestedAgentNames.add(reviewer.agent);
			requestedAgentNames.add(params.panel.synthesizer.agent);
		}
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a): a is AgentConfig => a?.source === "project");

		if (projectAgentsRequested.length > 0) {
			if (!ctx.isProjectTrusted()) {
				throw new Error("Project-local subagent definitions require a trusted project");
			}
			if (confirmProjectAgents && ctx.hasUI) {
				const names = projectAgentsRequested
					.map((agent) => safeTerminalLine(agent.name, 256))
					.join(", ");
				const dir = safeTerminalLine(discovery.projectAgentsDir ?? "(unknown)");
				const ok = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (signal?.aborted) {
					const error = new Error("Subagent call was aborted during project-agent confirmation");
					error.name = "AbortError";
					throw error;
				}
				if (!ok) {
					return {
						content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
						details: makeDetails(
							hasChain
								? "chain"
								: hasTasks
									? "parallel"
									: hasWorkflow
										? "workflow"
										: hasPanel
											? "panel"
											: "single",
						)([]),
					};
				}
			}
		}
	}

	orchestrationDeadline =
		params.totalTimeoutMs === undefined
			? undefined
			: Date.now() + Math.floor(params.totalTimeoutMs);
	if (params.panel && panelTarget) {
		return executePanel({
			toolCallId,
			params,
			panel: params.panel,
			signal,
			onUpdate,
			ctx,
			agents,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			maxParallelTasks,
			target: panelTarget,
			resolveThinkingLevel,
			resolveTimeoutMs,
		});
	}
	if (params.workflow && resolvedWorkflowTasks.length > 0 && workLedger) {
		await persistWorkLedger();
		const status = startSubagentStatus(
			ctx,
			toolCallId,
			parallelStatus(0, resolvedWorkflowTasks.length, 0),
		);
		const scheduler = new AdaptiveScheduler();
		const taskById = new Map(
			resolvedWorkflowTasks.map((task, index) => [task.id, { task, index }]),
		);
		const resultsById = new Map<string, SingleResult>();
		const deadline = orchestrationDeadline;
		const cancelWorkflowGeneration = () => {
			for (const item of workLedger.snapshot().items) {
				if (
					item.state === "running" ||
					item.state === "awaiting-verification" ||
					(item.state === "completed" && item.acceptanceState === "pending")
				) {
					workLedger.invalidate(item.id, "parent-aborted");
				}
			}
		};
		let completionController: WorkflowCompletionController | undefined;
		let abortListenerAttached = false;
		try {
			completionController = verifiedWorkflow
				? new WorkflowCompletionController({
						ledger: workLedger,
						cwd:
							workflowTargets[
								resolvedWorkflowTasks.findIndex((task) => task.id === verifiedWorkflow.targetTaskId)
							]?.cwd ?? ctx.cwd,
						targetTaskId: verifiedWorkflow.targetTaskId,
						verifierTaskId: verifiedWorkflow.verifierTaskId,
						checks: verifiedWorkflow.checks,
						signal,
						deadlineAt: deadline,
					})
				: undefined;
			signal?.addEventListener("abort", cancelWorkflowGeneration, { once: true });
			abortListenerAttached = signal !== undefined;
			while (true) {
				const snapshot = workLedger.snapshot();
				const remainingBudgetMs =
					deadline === undefined
						? MAX_SUBAGENT_TIMEOUT_MS
						: Math.max(0, Math.floor(deadline - Date.now()));
				const decision = scheduler.decide(snapshot, {
					maxConcurrency: Math.min(MAX_BLOCKING_PARALLEL_CONCURRENCY, maxParallelTasks),
					activeCount: 0,
					transportCapacity: MAX_BLOCKING_PARALLEL_CONCURRENCY,
					remainingBudgetMs,
				});
				workflowScheduling.push(decision);
				if (decision.selected.length === 0) break;
				status.update(
					parallelStatus(resultsById.size, resolvedWorkflowTasks.length, decision.selected.length),
				);
				const batch = await mapWithConcurrencyLimit(
					decision.selected,
					decision.effectiveConcurrency,
					async (workItemId) => {
						const entry = taskById.get(workItemId);
						if (!entry) throw new Error(`Missing workflow task ${workItemId}`);
						const { task, index } = entry;
						const dependencies = (task.dependsOn ?? [])
							.map((dependency) => resultsById.get(dependency))
							.filter((result): result is SingleResult => result !== undefined);
						const managedVerifier =
							completionController !== undefined && workItemId === verifiedWorkflow?.verifierTaskId;
						const verifierDependency = task.verifierFor
							? resultsById.get(task.verifierFor)
							: undefined;
						const verifierStructuredResult =
							verifierDependency?.structuredResult?.version === "pi-subagents:result:v2"
								? verifierDependency.structuredResult
								: undefined;
						const dependencyContext = managedVerifier
							? ""
							: task.verifierFor
								? verifierStructuredResult
									? `\n\nStaged target result:\n${redactPrivateText(
											JSON.stringify(verifierStructuredResult),
										)}`
									: ""
								: dependencies.length
									? `\n\nDependency results:\n${buildFanInContext(dependencies)}`
									: "";
						const displayTask = task.task;
						const target = workflowTargets[index];
						const thinkingLevel = resolveThinkingLevel(task.agent, task.thinkingLevel);
						let verifierTreeIdentity:
							| Awaited<ReturnType<typeof captureWorkflowTreeIdentity>>
							| undefined;
						let verifierPreflightError: string | undefined;
						let verifierPreflightCode: string | undefined;
						if (task.verifierFor) {
							const staged = workLedger.get(task.verifierFor);
							if (!staged?.stagedTreeIdentity) {
								verifierPreflightCode = "verification-tree-unavailable";
								verifierPreflightError = `Verification target ${task.verifierFor} has no staged tree identity`;
							} else {
								try {
									verifierTreeIdentity = await captureWorkflowTreeIdentity(target.cwd, { signal });
									if (!sameWorkflowTreeIdentity(staged.stagedTreeIdentity, verifierTreeIdentity)) {
										verifierPreflightCode = "verification-tree-mismatch";
										verifierPreflightError =
											"Workflow verification tree changed before verifier launch";
									}
								} catch (error) {
									if (signal?.aborted) throw error;
									verifierPreflightCode = "verification-tree-unavailable";
									verifierPreflightError = error instanceof Error ? error.message : String(error);
								}
							}
						}
						const verificationTargetTask = task.verifierFor
							? taskById.get(task.verifierFor)?.task
							: undefined;
						const verificationTargetContract = normalizeDelegationContract(
							verificationTargetTask?.contract,
						);
						const managedVerificationInstruction = managedVerifier
							? completionController?.verifierPrompt()
							: undefined;
						if (managedVerifier && !managedVerificationInstruction) {
							throw new Error("Verified execution verifier instruction is unavailable");
						}
						const verificationSuffix = managedVerifier
							? `\n\n${managedVerificationInstruction}`
							: task.verifierFor && verifierTreeIdentity
								? `\n\n${workflowVerificationInstruction(task.verifierFor, verifierTreeIdentity, {
										acceptanceCriteria: [
											...(verificationTargetTask?.acceptanceCriteria ?? []),
											...(verificationTargetContract?.acceptanceCriteria ?? []),
										],
										requiredEvidence: verificationTargetContract?.requiredEvidence ?? [],
									})}`
								: "";
						const reworkSuffix =
							completionController &&
							workItemId === verifiedWorkflow?.targetTaskId &&
							(workLedger.get(workItemId)?.taskGeneration ?? 1) > 1
								? `\n\n${completionController.reworkPrompt()}`
								: "";
						const baseTask = `${task.task}${dependencyContext}`;
						const requiredSuffix = `${reworkSuffix}${verificationSuffix}`;
						const baseBudget = Math.max(
							0,
							DEFAULT_MAX_CONTEXT_BYTES - Buffer.byteLength(requiredSuffix, "utf8"),
						);
						const taskWithContext = `${truncateUtf8(baseTask, baseBudget).text}${requiredSuffix}`;
						const prepared = prepareTask(taskWithContext, task);
						const startedItem = startWorkItem(workItemId, task.agent);
						const acceptedTaskGeneration = startedItem?.taskGeneration ?? 0;
						await persistWorkLedger();
						const runAttempt = (attemptSignal: AbortSignal | undefined) => {
							const budget = resolveExecutionBudget(task.agent, task.timeoutMs);
							if (!budget) {
								return Promise.resolve(exhaustedResult(task.agent, displayTask, thinkingLevel));
							}
							const childPolicy = launchPolicy(
								target,
								prepared,
								displayTask,
								task.agent,
								thinkingLevel,
								budget.timeoutMs,
								acceptedTaskGeneration,
								budget,
								resolveTurnLimits(task),
							);
							return runSingleAgent(
								ctx.cwd,
								agents,
								task.agent,
								prepared.text,
								target.cwd,
								undefined,
								attemptSignal,
								thinkingLevel,
								budget.timeoutMs,
								undefined,
								makeDetails("workflow"),
								undefined,
								managedVerifier
									? {
											...childPolicy,
											disableExtensions: true,
											disableSkills: true,
											disablePromptTemplates: true,
											disableContextFiles: true,
										}
									: childPolicy,
							);
						};
						const maxAttempts = task.retryPolicy?.maxAttempts ?? 1;
						let result: SingleResult | undefined = verifierPreflightError
							? attachTarget(
									workflowFailureResult(
										task.agent,
										displayTask,
										verifierPreflightCode ?? "verification-tree-unavailable",
										verifierPreflightError,
										thinkingLevel,
									),
									target,
								)
							: undefined;
						let hedged = false;
						for (let attempt = 1; !verifierPreflightError && attempt <= maxAttempts; attempt++) {
							if (attempt > 1 && deadline !== undefined && Date.now() >= deadline) break;
							const attempted = await runHedgedAttempt(runAttempt, signal, task.hedgeAfterMs);
							hedged ||= attempted.hedged;
							result = attachTarget(
								{
									...attempted.result,
									attemptCount: attempt,
									hedged: hedged || undefined,
								},
								target,
							);
							if (!isRetryableResult(result) || attempt >= maxAttempts) break;
							if (deadline !== undefined && Date.now() >= deadline) break;
							await supervisionDelay(task.retryPolicy?.backoffMs ?? 0, signal);
						}
						if (!result) throw new Error(`Workflow task ${workItemId} produced no result`);
						if (workLedger.get(workItemId)?.taskGeneration !== acceptedTaskGeneration) {
							result.outcome = {
								status: "stale",
								reasonCode: "cancelled-generation",
								recoveryActions: ["discard", "replan"],
								retryable: false,
							};
						}
						resultsById.set(workItemId, result);
						if (result.outcome?.status === "stale") {
							// Cancellation or replacement already rotated and invalidated this generation.
						} else if (managedVerifier && completionController) {
							const structured =
								result.structuredResult?.version === "pi-subagents:result:v2"
									? result.structuredResult
									: undefined;
							try {
								if (!structured || !result.executionPlan?.id) {
									throw new Error(
										"Verified execution verifier did not return a current structured-v2 result",
									);
								}
								const completion = await completionController.completeVerifier({
									taskGeneration: acceptedTaskGeneration,
									executionPlanId: result.executionPlan.id,
									verifierAgent: task.agent,
									result: structured,
									sourceTruncated: result.truncated,
								});
								const targetItem = workLedger.get(verifiedWorkflow?.targetTaskId ?? "");
								if (
									completion.decision === "rework" &&
									targetItem?.acceptanceState === "rework-requested"
								) {
									const targetResult = resultsById.get(targetItem.id);
									if (targetResult?.capabilityGrant?.state === "active") {
										targetResult.capabilityGrant = revokeCapabilityGrant(
											targetResult.capabilityGrant,
											"verification-rework",
											Date.now(),
										);
									}
									if (result.capabilityGrant?.state === "active") {
										result.capabilityGrant = revokeCapabilityGrant(
											result.capabilityGrant,
											"verification-rework",
											Date.now(),
										);
									}
									completionController.beginRework();
								} else if (completion.decision !== "accept" && targetItem) {
									const targetResult = resultsById.get(targetItem.id);
									if (targetResult) {
										targetResult.outcome = {
											status: "failed",
											reasonCode: targetItem.outcomeReason ?? "verification-rejected",
											recoveryActions: ["stop"],
											retryable: false,
										};
									}
								}
							} catch (error) {
								if (signal?.aborted) throw error;
								const message = error instanceof Error ? error.message : String(error);
								const reasonCode = workflowCompletionFailureReason(error);
								result.outcome = {
									status: "failed",
									reasonCode,
									recoveryActions: ["revalidate"],
									retryable: false,
								};
								result.errorMessage = message;
								const verifierItem = workLedger.get(workItemId);
								if (verifierItem?.state === "running") {
									workLedger.failVerification(workItemId, reasonCode);
								}
							}
						} else if (task.verifierFor) {
							const staged = workLedger.get(task.verifierFor);
							const structured =
								result.structuredResult?.version === "pi-subagents:result:v2"
									? result.structuredResult
									: undefined;
							let failureReason: string | undefined = verifierPreflightError;
							let failureCode: string | undefined = verifierPreflightCode;
							let postVerifierIdentity = verifierTreeIdentity;
							if (!failureReason) {
								try {
									postVerifierIdentity = await captureWorkflowTreeIdentity(target.cwd, { signal });
									if (
										!verifierTreeIdentity ||
										!staged?.stagedTreeIdentity ||
										!sameWorkflowTreeIdentity(verifierTreeIdentity, postVerifierIdentity) ||
										!sameWorkflowTreeIdentity(staged.stagedTreeIdentity, postVerifierIdentity)
									) {
										failureCode = "verification-tree-mismatch";
										failureReason = "Workflow verification tree changed during verifier execution";
									}
								} catch (error) {
									if (signal?.aborted) throw error;
									failureCode = "verification-tree-unavailable";
									failureReason = error instanceof Error ? error.message : String(error);
								}
							}
							if (
								!failureReason &&
								structured &&
								staged?.acceptedExecutionPlanId &&
								result.executionPlan?.id &&
								postVerifierIdentity
							) {
								try {
									const receipt = createWorkflowVerificationReceipt(structured, {
										targetTaskId: staged.id,
										targetTaskGeneration: staged.taskGeneration,
										targetExecutionPlanId: staged.acceptedExecutionPlanId,
										verifierTaskId: workItemId,
										verifierTaskGeneration: acceptedTaskGeneration,
										verifierExecutionPlanId: result.executionPlan.id,
										treeIdentity: postVerifierIdentity,
										sourceTruncated: result.truncated === true,
									});
									workLedger.completeVerification(workItemId, {
										taskGeneration: acceptedTaskGeneration,
										executionPlanId: result.executionPlan.id,
										receipt,
									});
									if (receipt.decision !== "accept") {
										const targetResult = resultsById.get(staged.id);
										if (targetResult) {
											targetResult.outcome = {
												status: receipt.decision === "rework" ? "blocked" : "failed",
												reasonCode:
													receipt.decision === "rework"
														? "verification-rework"
														: "verification-rejected",
												recoveryActions:
													receipt.decision === "rework" ? ["replan", "verify"] : ["stop"],
												retryable: false,
											};
										}
									}
								} catch (error) {
									failureCode = "verification-receipt-invalid";
									failureReason = error instanceof Error ? error.message : String(error);
								}
							} else if (!failureReason) {
								failureCode = "verification-receipt-invalid";
								failureReason = "Workflow verifier did not return a current structured-v2 result";
							}
							if (failureReason) {
								const reasonCode = failureCode ?? "verification-receipt-invalid";
								result.outcome = {
									status:
										reasonCode === "verification-receipt-invalid" ? "contract-invalid" : "failed",
									reasonCode,
									recoveryActions:
										reasonCode === "verification-receipt-invalid"
											? ["repair-contract"]
											: ["revalidate"],
									retryable: false,
								};
								result.errorMessage = failureReason;
								workLedger.failVerification(workItemId, reasonCode);
							}
						} else if (
							completionController &&
							workItemId === verifiedWorkflow?.targetTaskId &&
							!isResultError(result)
						) {
							try {
								if (!result.executionPlan?.id) {
									throw new Error("Verified execution producer has no accepted ExecutionPlan");
								}
								await completionController.stageTarget({
									taskGeneration: acceptedTaskGeneration,
									executionPlanId: result.executionPlan.id,
									artifacts: artifactsFromResult(result),
								});
							} catch (error) {
								if (signal?.aborted) throw error;
								const message = error instanceof Error ? error.message : String(error);
								result.outcome = {
									status: "failed",
									reasonCode: "verification-checks-unavailable",
									recoveryActions: ["revalidate"],
									retryable: false,
								};
								result.errorMessage = message;
								if (workLedger.get(workItemId)?.state === "running") {
									settleWorkItem(workItemId, result, acceptedTaskGeneration);
								}
							}
						} else if (verificationTargetIds.has(workItemId) && !isResultError(result)) {
							try {
								const treeIdentity = await captureWorkflowTreeIdentity(target.cwd, { signal });
								if (!result.executionPlan?.id) {
									throw new Error("Verification-required producer has no accepted ExecutionPlan");
								}
								workLedger.stageForVerification(workItemId, {
									taskGeneration: acceptedTaskGeneration,
									executionPlanId: result.executionPlan.id,
									artifacts: artifactsFromResult(result),
									treeIdentity,
								});
							} catch (error) {
								if (signal?.aborted) throw error;
								const message = error instanceof Error ? error.message : String(error);
								result.outcome = {
									status: "failed",
									reasonCode: "verification-tree-unavailable",
									recoveryActions: ["revalidate"],
									retryable: false,
								};
								result.errorMessage = message;
								settleWorkItem(workItemId, result, acceptedTaskGeneration);
							}
						} else {
							settleWorkItem(workItemId, result, acceptedTaskGeneration);
						}
						await persistWorkLedger();
						return result;
					},
					signal,
				);
				if (batch.length === 0 || signal?.aborted) break;
			}
			for (const item of workLedger.snapshot().items) {
				if (
					item.state !== "pending" &&
					item.state !== "ready" &&
					item.state !== "awaiting-verification" &&
					!(item.state === "completed" && item.acceptanceState === "pending")
				) {
					continue;
				}
				if (signal?.aborted) {
					workLedger.settle(item.id, "interrupted", "parent-aborted");
				} else if (deadline !== undefined && Date.now() >= deadline) {
					workLedger.settle(item.id, "blocked", "budget-exhausted");
				} else if (
					item.state === "awaiting-verification" ||
					(item.state === "completed" && item.acceptanceState === "pending")
				) {
					workLedger.settle(item.id, "blocked", "verification-not-completed");
				} else {
					const dependencyBlocked = item.dependencies.some(
						(dependency) => workLedger.get(dependency)?.state !== "completed",
					);
					workLedger.settle(
						item.id,
						dependencyBlocked ? "blocked" : "needs-input",
						dependencyBlocked ? "dependency-not-completed" : "artifact-version-mismatch",
					);
				}
			}
			await persistWorkLedger();
			const results = resolvedWorkflowTasks.map((task) => {
				const completed = resultsById.get(task.id);
				const item = workLedger.get(task.id);
				if (completed) {
					if (
						item &&
						(item.state !== "completed" ||
							(item.acceptanceRequired && item.acceptanceState !== "accepted")) &&
						!isResultError(completed)
					) {
						completed.outcome = {
							status:
								item.state === "needs-input"
									? "needs-input"
									: item.state === "interrupted"
										? "interrupted"
										: item.state === "failed"
											? "failed"
											: "blocked",
							reasonCode: item.outcomeReason ?? "verification-not-accepted",
							recoveryActions:
								item.outcomeReason === "verification-rework" ? ["replan", "verify"] : ["stop"],
							retryable: false,
						};
					}
					return completed;
				}
				const outcomeStatus =
					item?.state === "interrupted"
						? "interrupted"
						: item?.state === "needs-input"
							? "needs-input"
							: "blocked";
				const reasonCode = item?.outcomeReason ?? "dependency-not-satisfied";
				return {
					agent: task.agent,
					agentSource: agents.find((agent) => agent.name === task.agent)?.source ?? "unknown",
					task: task.task,
					exitCode: 1,
					messages: [],
					stderr: "Workflow dependency was not satisfied",
					errorMessage: `Workflow task did not start: ${reasonCode}`,
					aborted: outcomeStatus === "interrupted",
					outcome: {
						status: outcomeStatus,
						reasonCode,
						recoveryActions:
							outcomeStatus === "needs-input"
								? ["supply-input"]
								: outcomeStatus === "interrupted"
									? ["retry"]
									: ["resolve-dependency"],
						retryable: outcomeStatus === "interrupted",
					},
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						contextTokens: 0,
						turns: 0,
					},
					finalOutput: "",
				} satisfies SingleResult;
			});
			const successCount = results.filter((result) => !isResultError(result)).length;
			const attemptCount = results.reduce((sum, result) => sum + (result.attemptCount ?? 1), 0);
			const hedgeCount = results.filter((result) => result.hedged).length;
			const isError = successCount !== results.length;
			return {
				content: [
					{
						type: "text",
						text: `Workflow: ${successCount}/${results.length} succeeded; ${attemptCount} attempt(s), ${hedgeCount} hedged task(s).`,
					},
				],
				details: { ...makeDetails("workflow")(results), isError },
				isError: isError || undefined,
			};
		} finally {
			if (abortListenerAttached) {
				signal?.removeEventListener("abort", cancelWorkflowGeneration);
			}
			completionController?.dispose();
			try {
				await persistWorkLedger();
			} finally {
				status.clear();
			}
		}
	}

	if (params.chain && params.chain.length > 0) {
		const results: SingleResult[] = [];
		let previousOutput = "";
		const status = startSubagentStatus(ctx, toolCallId, chainStatus(0, params.chain.length));

		try {
			for (let i = 0; i < params.chain.length; i++) {
				const step = params.chain[i];
				status.update(chainStatus(i + 1, params.chain.length, step.agent));
				const taskWithContext = truncateUtf8(
					step.task.replace(/\{previous\}/g, previousOutput),
					DEFAULT_MAX_CONTEXT_BYTES,
				).text;
				const prepared = prepareTask(taskWithContext, step);

				// Create update callback that includes all previous results
				const chainUpdate: OnUpdateCallback | undefined = onUpdate
					? (partial) => {
							// Combine completed results with current streaming result
							const currentResult = partial.details?.results[0];
							if (currentResult) {
								const allResults = [...results, currentResult];
								onUpdate({
									content: partial.content,
									details: makeDetails("chain")(allResults),
								});
							}
						}
					: undefined;

				const target = chainTargets[i];
				const thinkingLevel = resolveThinkingLevel(step.agent, step.thinkingLevel);
				const budget = resolveExecutionBudget(step.agent, step.timeoutMs);
				const taskGeneration = startWorkItem(`step-${i + 1}`, step.agent)?.taskGeneration ?? 0;
				const result = attachTarget(
					budget
						? await runSingleAgent(
								ctx.cwd,
								agents,
								step.agent,
								prepared.text,
								target.cwd,
								i + 1,
								signal,
								thinkingLevel,
								budget.timeoutMs,
								chainUpdate,
								makeDetails("chain"),
								undefined,
								launchPolicy(
									target,
									prepared,
									taskWithContext,
									step.agent,
									thinkingLevel,
									budget.timeoutMs,
									taskGeneration,
									budget,
									resolveTurnLimits(step),
								),
							)
						: exhaustedResult(step.agent, taskWithContext, thinkingLevel, i + 1),
					target,
				);
				results.push(result);
				settleWorkItem(`step-${i + 1}`, result, taskGeneration);

				const isError = isResultError(result);
				if (isError) {
					const errorMsg = formatResultFailure(result);
					return {
						content: [
							{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
						],
						details: { ...makeDetails("chain")(results), isError: true },
						isError: true,
					};
				}
				previousOutput = result.structuredResult
					? JSON.stringify(result.structuredResult)
					: getResultFinalOutput(result);
			}
			return {
				content: [
					{
						type: "text",
						text: getResultFinalOutput(results[results.length - 1]) || "(no output)",
					},
				],
				details: makeDetails("chain")(results),
			};
		} finally {
			status.clear();
		}
	}

	if (params.tasks && params.tasks.length > 0) {
		const status = startSubagentStatus(
			ctx,
			toolCallId,
			parallelStatus(0, params.tasks.length, params.tasks.length),
		);

		try {
			// Track all results for streaming updates
			const allResults: SingleResult[] = new Array(params.tasks.length);

			// Initialize placeholder results
			for (let i = 0; i < params.tasks.length; i++) {
				allResults[i] = {
					agent: params.tasks[i].agent,
					agentSource: "unknown",
					task: params.tasks[i].task,
					exitCode: -1, // -1 = still running
					messages: [],
					stderr: "",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						contextTokens: 0,
						turns: 0,
					},
					thinkingLevel: resolveThinkingLevel(params.tasks[i].agent, params.tasks[i].thinkingLevel),
					finalOutput: "",
				};
			}

			let doneCount = 0;
			let runningCount = params.tasks.length;

			const emitParallelUpdate = () => {
				status.update(parallelStatus(doneCount, allResults.length, runningCount));
				if (onUpdate) {
					const pendingAggregator: SingleResult | undefined =
						aggregator && !signal?.aborted && doneCount === allResults.length
							? {
									agent: aggregator.agent,
									agentSource:
										agents.find((agent) => agent.name === aggregator.agent)?.source ?? "unknown",
									task: aggregator.task,
									exitCode: -1,
									messages: [],
									stderr: "",
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0,
										contextTokens: 0,
										turns: 0,
									},
									thinkingLevel: resolveThinkingLevel(aggregator.agent, aggregator.thinkingLevel),
									timeoutMs: resolveTimeoutMs(aggregator.agent, aggregator.timeoutMs),
									finalOutput: "",
								}
							: undefined;
					onUpdate({
						content: [
							{
								type: "text",
								text: `Parallel: ${doneCount}/${allResults.length} done, ${runningCount} running...`,
							},
						],
						details: makeDetails("parallel")([...allResults], pendingAggregator),
					});
				}
			};

			const results = await mapWithConcurrencyLimit(
				params.tasks,
				MAX_BLOCKING_PARALLEL_CONCURRENCY,
				async (t, index) => {
					const target = parallelTargets[index];
					const prepared = prepareTask(t.task, t);
					const thinkingLevel = resolveThinkingLevel(t.agent, t.thinkingLevel);
					const budget = resolveExecutionBudget(t.agent, t.timeoutMs);
					const taskGeneration = startWorkItem(`task-${index + 1}`, t.agent)?.taskGeneration ?? 0;
					const result = attachTarget(
						budget
							? await runSingleAgent(
									ctx.cwd,
									agents,
									t.agent,
									prepared.text,
									target.cwd,
									undefined,
									signal,
									thinkingLevel,
									budget.timeoutMs,
									(partial) => {
										if (partial.details?.results[0]) {
											allResults[index] = { ...partial.details.results[0], exitCode: -1 };
											emitParallelUpdate();
										}
									},
									makeDetails("parallel"),
									undefined,
									launchPolicy(
										target,
										prepared,
										t.task,
										t.agent,
										thinkingLevel,
										budget.timeoutMs,
										taskGeneration,
										budget,
										resolveTurnLimits(t),
									),
								)
							: exhaustedResult(t.agent, t.task, thinkingLevel),
						target,
					);
					allResults[index] = result;
					settleWorkItem(`task-${index + 1}`, result, taskGeneration);
					doneCount += 1;
					runningCount -= 1;
					emitParallelUpdate();
					return result;
				},
				signal,
				(task, index) => {
					const taskGeneration =
						startWorkItem(`task-${index + 1}`, task.agent)?.taskGeneration ?? 0;
					const skipped: SingleResult = {
						...allResults[index],
						task: task.task,
						exitCode: 130,
						stopReason: "aborted",
						aborted: true,
						errorMessage: "Subagent was not started because the parent call was aborted",
					};
					allResults[index] = skipped;
					settleWorkItem(`task-${index + 1}`, skipped, taskGeneration);
					doneCount += 1;
					runningCount -= 1;
					emitParallelUpdate();
					return skipped;
				},
			);

			let aggregatorResult: SingleResult | undefined;
			if (aggregator && !signal?.aborted) {
				status.update(fanInStatus(aggregator.agent));
				const fanInContext = buildFanInContext(results);
				const aggregatorTask = truncateUtf8(
					aggregator.task.includes("{previous}")
						? aggregator.task.replace(/\{previous\}/g, fanInContext)
						: `${aggregator.task}\n\nParallel task outputs:\n\n${fanInContext}`,
					DEFAULT_MAX_CONTEXT_BYTES,
				).text;
				const prepared = prepareTask(aggregatorTask, aggregator);
				const target = aggregatorTarget as ResolvedSubagentTarget;
				const thinkingLevel = resolveThinkingLevel(aggregator.agent, aggregator.thinkingLevel);
				const budget = resolveExecutionBudget(aggregator.agent, aggregator.timeoutMs);
				const taskGeneration = startWorkItem("aggregator", aggregator.agent)?.taskGeneration ?? 0;
				aggregatorResult = attachTarget(
					budget
						? await runSingleAgent(
								ctx.cwd,
								agents,
								aggregator.agent,
								prepared.text,
								target.cwd,
								undefined,
								signal,
								thinkingLevel,
								budget.timeoutMs,
								(partial) => {
									status.update(fanInStatus(aggregator.agent));
									if (onUpdate && partial.details?.results[0]) {
										onUpdate({
											content: partial.content,
											details: makeDetails("parallel")(results, partial.details.results[0]),
										});
									}
								},
								makeDetails("parallel"),
								undefined,
								launchPolicy(
									target,
									prepared,
									aggregatorTask,
									aggregator.agent,
									thinkingLevel,
									budget.timeoutMs,
									taskGeneration,
									budget,
									resolveTurnLimits(aggregator),
								),
							)
						: exhaustedResult(aggregator.agent, aggregatorTask, thinkingLevel),
					target,
				);
				settleWorkItem("aggregator", aggregatorResult, taskGeneration);
			}

			const successCount = results.filter((result) => !isResultError(result)).length;
			const summaries = results.map((result) => {
				const failed = isResultError(result);
				const output = getResultFinalOutput(result);
				const error = result.errorMessage || result.stderr.trim();
				const summaryText = failed ? formatResultFailure(result) : output || error;
				// fix: return full task outputs instead of 160-byte previews; tiny previews forced
				// the parent agent to re-run the delegated work itself, doubling token spend.
				// Still bounded by the standard 50KB tool-output cap.
				const preview = truncateUtf8(summaryText, DEFAULT_MAX_OUTPUT_BYTES).text;
				return `[${result.agent}] ${failed ? "failed" : "completed"}: ${preview || "(no output)"}`;
			});
			const aggregatorFailed = aggregatorResult ? isResultError(aggregatorResult) : false;
			const aggregatorOutput = aggregatorResult ? getResultFinalOutput(aggregatorResult) : "";
			const aggregatorError =
				aggregatorResult?.errorMessage || aggregatorResult?.stderr.trim() || "";
			return {
				content: [
					{
						type: "text",
						text: aggregatorResult
							? aggregatorFailed
								? formatResultFailure(aggregatorResult)
								: aggregatorOutput ||
									aggregatorError ||
									`(aggregator ${aggregatorResult.agent} produced no output)`
							: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
					},
				],
				details: {
					...makeDetails("parallel")(results, aggregatorResult),
					isError: aggregatorFailed,
				},
				isError: aggregatorResult ? aggregatorFailed : undefined,
			};
		} finally {
			status.clear();
		}
	}

	if (params.agent && params.task) {
		const status = startSubagentStatus(ctx, toolCallId, singleStatus(params.agent));

		try {
			const target = singleTarget as ResolvedSubagentTarget;
			const prepared = prepareTask(params.task, params);
			const thinkingLevel = resolveThinkingLevel(params.agent, params.thinkingLevel);
			const budget = resolveExecutionBudget(params.agent, params.timeoutMs);
			const taskGeneration = startWorkItem("task-1", params.agent)?.taskGeneration ?? 0;
			const result = attachTarget(
				budget
					? await runSingleAgent(
							ctx.cwd,
							agents,
							params.agent,
							prepared.text,
							target.cwd,
							undefined,
							signal,
							thinkingLevel,
							budget.timeoutMs,
							onUpdate,
							makeDetails("single"),
							undefined,
							launchPolicy(
								target,
								prepared,
								params.task,
								params.agent,
								thinkingLevel,
								budget.timeoutMs,
								taskGeneration,
								budget,
								resolveTurnLimits(params),
							),
						)
					: exhaustedResult(params.agent, params.task, thinkingLevel),
				target,
			);
			settleWorkItem("task-1", result, taskGeneration);
			const isError = isResultError(result);
			if (isError) {
				const errorMsg = formatResultFailure(result);
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: { ...makeDetails("single")([result]), isError: true },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getResultFinalOutput(result) || "(no output)" }],
				details: makeDetails("single")([result]),
			};
		} finally {
			status.clear();
		}
	}

	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
		details: makeDetails("single")([]),
	};
}
