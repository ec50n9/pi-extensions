import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	type SubagentSettings,
	type SubagentThinkingLevel,
} from "./agents.js";
import type { CapabilityCeilingRegistry } from "./capability-ceiling.js";
import {
	assertDelegationTargetAllowed,
	type ResolvedSubagentTarget,
	resolveSubagentTarget,
	targetPolicyAudit,
} from "./cwd-policy.js";
import {
	appendEvidenceInstruction,
	type EvidencePolicy,
	parseEvidenceAttestation,
} from "./evidence.js";
import { launchPolicyFromContract, resolveLaunchContract } from "./launch-contract.js";
import {
	DEFAULT_MAX_CONTEXT_BYTES,
	MAX_BLOCKING_PARALLEL_CONCURRENCY,
	truncateUtf8,
} from "./limits.js";
import { hasUsableAggregator, type SubagentParams } from "./params.js";
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
	readSubagentSettings,
	resolveBlockingMaxParallelTasks,
	resolveSubagentThinkingLevel,
} from "./settings.js";

export const FALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_KEY = "subagents";
const activeStatuses = new Map<string, string>();

export function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveDefaultSubagentTimeoutMs(): number {
	return parsePositiveInteger(process.env.PI_SUBAGENT_TIMEOUT_MS) ?? FALLBACK_TIMEOUT_MS;
}

export function assertSubagentDepthAllowed(): void {
	const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
	const maxDepth = parsePositiveInteger(process.env.PI_SUBAGENT_MAX_DEPTH) ?? 1;
	if (depth >= maxDepth) {
		throw new Error(`Subagent recursion depth limit reached (${maxDepth})`);
	}
}

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

function startSubagentStatus(ctx: StatusContext, toolCallId: string, status: string) {
	let cleared = false;

	const update = (nextStatus: string) => {
		if (cleared) return;
		activeStatuses.set(toolCallId, nextStatus);
		publishSubagentStatus(ctx);
	};

	update(status);

	return {
		update,
		clear() {
			if (cleared) return;
			cleared = true;
			activeStatuses.delete(toolCallId);
			publishSubagentStatus(ctx);
		},
	};
}

function publishSubagentStatus(ctx: StatusContext) {
	const statuses = [...activeStatuses.values()];
	if (statuses.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const suffix = statuses.length > 1 ? ` +${statuses.length - 1}` : "";
	ctx.ui.setStatus(STATUS_KEY, `${statuses[0]}${suffix}`);
}

function singleStatus(agent: string): string {
	return `${agent}`;
}

function chainStatus(step: number, total: number, agent?: string): string {
	return `chain ${step}/${total}${agent ? ` ${agent}` : ""}`;
}

function parallelStatus(done: number, total: number, running: number): string {
	return `parallel ${done}/${total} done${running > 0 ? ` ${running} running` : ""}`;
}

function fanInStatus(agent: string): string {
	return `fan-in ${agent}`;
}

export async function executeSubagent(
	toolCallId: string,
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
	ctx: ExtensionContext,
	settingsOverride?: SubagentSettings,
	ceilings?: CapabilityCeilingRegistry,
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
	const confirmProjectAgents = params.confirmProjectAgents ?? true;
	const resolveTimeoutMs = (agentName: string, localTimeoutMs?: number) =>
		localTimeoutMs ??
		params.timeoutMs ??
		agents.find((agent) => agent.name === agentName)?.timeoutMs ??
		resolveDefaultSubagentTimeoutMs();
	const resolveThinkingLevel = (agentName: string, localThinkingLevel?: SubagentThinkingLevel) =>
		resolveSubagentThinkingLevel(agents, agentName, params.thinkingLevel, localThinkingLevel);

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[], aggregator?: SingleResult): SubagentDetails => ({
			mode,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			results,
			aggregator,
		});

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
	if (hasTasks && (params.tasks?.length ?? 0) > maxParallelTasks) {
		throw new Error(
			`Too many parallel tasks (${params.tasks?.length ?? 0}). Configured max is ${maxParallelTasks}.`,
		);
	}

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
	const chainTargets = params.chain?.map((step) => resolveTarget(step.cwd)) ?? [];
	const parallelTargets = params.tasks?.map((task) => resolveTarget(task.cwd)) ?? [];
	const aggregatorTarget = aggregator ? resolveTarget(aggregator.cwd) : undefined;
	const prepareLaunch = (
		agentName: string,
		target: ResolvedSubagentTarget,
		thinkingLevel: SubagentThinkingLevel | undefined,
		timeoutMs: number,
		evidence: EvidencePolicy | undefined,
	) => {
		const agent = agents.find((candidate) => candidate.name === agentName);
		const ceiling = ceilings?.resolve() ?? { sources: [] };
		if (!agent) {
			if (ceiling.allowedAgents && !ceiling.allowedAgents.includes(agentName)) {
				throw new Error(`Subagent ${agentName} is denied by the active capability ceiling`);
			}
			return undefined;
		}
		return resolveLaunchContract({
			agent,
			agentScope,
			target: targetPolicyAudit(target),
			thinkingLevel,
			timeoutMs,
			transport: "subprocess",
			evidence,
			ceiling,
		});
	};
	const attachLaunch = (
		result: SingleResult,
		target: ResolvedSubagentTarget,
		originalTask: string,
		evidence: EvidencePolicy | undefined,
		contract: ReturnType<typeof prepareLaunch>,
	): SingleResult => {
		result.target = targetPolicyAudit(target);
		result.task = originalTask;
		result.evidence = parseEvidenceAttestation(getResultFinalOutput(result), evidence);
		result.launchContractDigest = contract?.digest;
		return result;
	};
	const launchPolicy = (
		contract: ReturnType<typeof prepareLaunch>,
		target: ResolvedSubagentTarget,
	) =>
		contract ? launchPolicyFromContract(contract) : { projectTrust: target.trust.projectTrusted };

	if (agentScope === "project" || agentScope === "both") {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (aggregator) requestedAgentNames.add(aggregator.agent);
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
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					};
				}
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
				const timeoutMs = resolveTimeoutMs(step.agent, step.timeoutMs);
				const evidence = step.evidence ?? params.evidence;
				const contract = prepareLaunch(step.agent, target, thinkingLevel, timeoutMs, evidence);
				const result = attachLaunch(
					await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						appendEvidenceInstruction(taskWithContext, evidence),
						target.cwd,
						i + 1,
						signal,
						thinkingLevel,
						timeoutMs,
						chainUpdate,
						makeDetails("chain"),
						undefined,
						launchPolicy(contract, target),
					),
					target,
					taskWithContext,
					evidence,
					contract,
				);
				results.push(result);

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
				previousOutput = getResultFinalOutput(result);
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
					const thinkingLevel = resolveThinkingLevel(t.agent, t.thinkingLevel);
					const timeoutMs = resolveTimeoutMs(t.agent, t.timeoutMs);
					const evidence = t.evidence ?? params.evidence;
					const contract = prepareLaunch(t.agent, target, thinkingLevel, timeoutMs, evidence);
					const result = attachLaunch(
						await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							appendEvidenceInstruction(t.task, evidence),
							target.cwd,
							undefined,
							signal,
							thinkingLevel,
							timeoutMs,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = { ...partial.details.results[0], exitCode: -1 };
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							undefined,
							launchPolicy(contract, target),
						),
						target,
						t.task,
						evidence,
						contract,
					);
					allResults[index] = result;
					doneCount += 1;
					runningCount -= 1;
					emitParallelUpdate();
					return result;
				},
				signal,
				(task, index) => {
					const skipped: SingleResult = {
						...allResults[index],
						task: task.task,
						exitCode: 130,
						stopReason: "aborted",
						aborted: true,
						errorMessage: "Subagent was not started because the parent call was aborted",
					};
					allResults[index] = skipped;
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
				const target = aggregatorTarget as ResolvedSubagentTarget;
				const thinkingLevel = resolveThinkingLevel(aggregator.agent, aggregator.thinkingLevel);
				const timeoutMs = resolveTimeoutMs(aggregator.agent, aggregator.timeoutMs);
				const evidence = aggregator.evidence ?? params.evidence;
				const contract = prepareLaunch(
					aggregator.agent,
					target,
					thinkingLevel,
					timeoutMs,
					evidence,
				);
				aggregatorResult = attachLaunch(
					await runSingleAgent(
						ctx.cwd,
						agents,
						aggregator.agent,
						appendEvidenceInstruction(aggregatorTask, evidence),
						target.cwd,
						undefined,
						signal,
						thinkingLevel,
						timeoutMs,
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
						launchPolicy(contract, target),
					),
					target,
					aggregatorTask,
					evidence,
					contract,
				);
			}

			const successCount = results.filter((result) => !isResultError(result)).length;
			const summaries = results.map((result) => {
				const failed = isResultError(result);
				const output = getResultFinalOutput(result);
				const error = result.errorMessage || result.stderr.trim();
				const summaryText = failed ? formatResultFailure(result) : output || error;
				const preview = truncateUtf8(summaryText, 160).text;
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
			const thinkingLevel = resolveThinkingLevel(params.agent, params.thinkingLevel);
			const timeoutMs = resolveTimeoutMs(params.agent, params.timeoutMs);
			const contract = prepareLaunch(
				params.agent,
				target,
				thinkingLevel,
				timeoutMs,
				params.evidence,
			);
			const result = attachLaunch(
				await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					appendEvidenceInstruction(params.task, params.evidence),
					target.cwd,
					undefined,
					signal,
					thinkingLevel,
					timeoutMs,
					onUpdate,
					makeDetails("single"),
					undefined,
					launchPolicy(contract, target),
				),
				target,
				params.task,
				params.evidence,
				contract,
			);
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
