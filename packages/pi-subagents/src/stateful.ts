import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentScope,
	type CompletionDelivery,
	discoverAgents,
	isThinkingLevel,
	type SubagentRuntimeSettings,
	type SubagentSettings,
	THINKING_LEVELS,
} from "./agents.js";
import type { CapabilityCeilingRegistry } from "./capability-ceiling.js";
import { CompletionDeliveryBroker } from "./completion-delivery.js";
import { buildContextSnapshot, type ContextMode, redactPrivateText } from "./context.js";
import {
	assertDelegationTargetAllowed,
	resolveSubagentTarget,
	targetPolicyAudit,
} from "./cwd-policy.js";
import type { EvidencePolicy } from "./evidence.js";
import { assertSubagentDepthAllowed, resolveDefaultSubagentTimeoutMs } from "./execution.js";
import { updateFleetWidget } from "./fleet-view.js";
import {
	type ChildSessionFactory,
	InProcessTransport,
	type ParentRuntimeSnapshot,
} from "./in-process-transport.js";
import { resolveLaunchContract } from "./launch-contract.js";
import {
	disabledLifecycleArtifactStatus,
	type LifecycleArtifactStatus,
	LifecycleArtifactWriter,
} from "./lifecycle-artifacts.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { AgentPersistence } from "./persistence.js";
import {
	AgentRegistry,
	type AgentRunInspectionDetail,
	type AgentRunInspectionSummary,
	type ManagedAgent,
} from "./registry.js";
import { DEFAULT_DELEGATION_CWD_POLICY, readSubagentSettings } from "./settings.js";
import { createSpawnPromptGuidelines } from "./stateful-guidance.js";
import { assertCurrentSpawn, disposeStatefulRuntime } from "./stateful-lifecycle.js";
import { resolveStatefulLimits, type StatefulLimits } from "./stateful-limits.js";
import { formatStatefulAgentLine, summarizeStatefulAgent } from "./stateful-presenter.js";
import { createStatefulToolRenderer } from "./stateful-render.js";
import {
	assertFollowUpWriteAllowed,
	assertNoSharedWriteConflict,
	confirmProjectAgent,
} from "./stateful-safety.js";

export {
	assertFollowUpWriteAllowed,
	assertNoSharedWriteConflict,
	isWriteCapable,
} from "./stateful-safety.js";

import {
	MailboxParamsSchema,
	ManageParamsSchema,
	validateMailboxParams,
	validateManageParams,
} from "./stateful-tool-params.js";
import { SubprocessTransport } from "./subprocess-transport.js";
import { WorkspaceManager } from "./workspace.js";

const ContextModeSchema = Type.Union([
	StringEnum(["none", "all", "summary"] as const),
	Type.Number({ minimum: 1, description: "Include the most recent N user turns." }),
]);
const ScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Per-invocation custom agent scope for this spawn. Default: "user". Use "project" for project-local agents or "both" for user and project agents; the selected scope is retained for follow-ups.',
	default: "user",
});
const StatefulThinkingLevelSchema = StringEnum(THINKING_LEVELS, {
	description:
		"Optional requested Pi thinking level selected for this task difficulty; retained for every turn of the spawned agent.",
});
const EvidenceSchema = StringEnum(["attested"] as const, {
	description: "Request bounded, unverified child evidence metadata for every turn.",
});
const MAX_TOOL_MESSAGE_BYTES = 2 * 1024;

export interface StatefulSubagentDependencies {
	blockingEnabled?: boolean;
	createInProcessSession?: ChildSessionFactory;
	workspaceManager?: WorkspaceManager;
	settings?: SubagentRuntimeSettings;
	getSettings?: () => SubagentSettings | undefined;
	ceilings?: CapabilityCeilingRegistry;
}

export interface StatefulSubagentRuntimeStatus {
	enabled: boolean;
	initialized: boolean;
	transport: "subprocess" | "in-process";
	completionDelivery: CompletionDelivery;
	limits: StatefulLimits;
	activeAgents: number;
	retainedAgents: number;
}

export interface StatefulSubagentController {
	getCompletionDelivery(): CompletionDelivery;
	setCompletionDelivery(value: CompletionDelivery): void;
	setAgentCatalog(value: string): void;
	refreshSettingsGuidance(): void;
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	getFleetView(): "off" | "active";
	getLifecycleArtifactStatus(): LifecycleArtifactStatus;
	listAgents(includeClosed?: boolean): ManagedAgent[];
	listRunInspection(includeClosed?: boolean): AgentRunInspectionSummary[];
	getRunInspection(agentId: string): AgentRunInspectionDetail | undefined;
	setFleetView(value: "off" | "active"): void;
	followUp(
		agentId: string,
		task: string,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<ManagedAgent>;
	queueMessage(agentId: string, message: string): Promise<void>;
	interruptAgent(agentId: string, subtree?: boolean): Promise<number>;
	closeAgent(agentId: string, subtree?: boolean): Promise<number>;
	clearAgents(): Promise<number>;
}

interface StatefulActionToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export function registerStatefulSubagents(
	pi: ExtensionAPI,
	dependencies: StatefulSubagentDependencies = {},
): StatefulSubagentController {
	const settings = Object.hasOwn(dependencies, "settings")
		? (dependencies.settings ?? {})
		: (readSubagentSettings()?.stateful ?? {});
	const blockingEnabled = dependencies.blockingEnabled !== false;
	const enabled = settings.enabled !== false;
	const transportKind = resolveStatefulTransportKind(settings.transport);
	let completionDelivery = resolveCompletionDelivery(settings.completionDelivery);
	let fleetView = settings.fleetView ?? "off";
	let runtimeLimits = resolveStatefulLimits(settings);
	let agentCatalog = "";
	let completionBroker: CompletionDeliveryBroker | undefined;
	let refreshSpawnToolRegistration: (() => void) | undefined;
	let registry: AgentRegistry | undefined;
	let persistence: AgentPersistence | undefined;
	let artifactWriter: LifecycleArtifactWriter | undefined;
	let activeContext: ExtensionContext | undefined;
	let sweepTimer: NodeJS.Timeout | undefined;
	let runtimeGeneration = 0;
	let runtimeTransition: Promise<void> = Promise.resolve();
	const workspaceManager = dependencies.workspaceManager ?? new WorkspaceManager();
	const isolatedAgents = new Map<string, string>();
	const seenMessageIds = new Set<string>();
	const parentRuntime: ParentRuntimeSnapshot = { model: undefined, thinkingLevel: "off" };
	const getCurrentSettings = () =>
		dependencies.getSettings ? dependencies.getSettings() : readSubagentSettings();
	const getCurrentStatefulSettings = () =>
		dependencies.getSettings ? (dependencies.getSettings()?.stateful ?? {}) : settings;
	const refreshFleet = (agents = registry?.list() ?? []) => {
		if (activeContext) updateFleetWidget(activeContext, fleetView === "active", agents);
	};
	const clearFleetBestEffort = (ctx: Pick<ExtensionContext, "mode" | "ui"> | undefined) => {
		if (!ctx) return;
		try {
			updateFleetWidget(ctx, false, []);
		} catch {
			// Widget cleanup must not block session replacement or shutdown.
		}
	};
	const requireRegistry = () => {
		if (!registry) throw new Error("Stateful subagents are not initialized for this session");
		return registry;
	};
	const requireAgent = (agentId: string) => {
		const agent = requireRegistry().get(agentId);
		if (!agent) throw new Error(`Unknown subagent: ${agentId}`);
		return agent;
	};

	const clearAgents = async (): Promise<number> => {
		const generation = runtimeGeneration;
		const currentRegistry = registry;
		const currentPersistence = persistence;
		if (!currentRegistry) return 0;
		const count = currentRegistry.list().length;
		const clear = async () => {
			await currentRegistry.closeAll();
			if (generation !== runtimeGeneration) return;
			await workspaceManager.cleanupAll();
			isolatedAgents.clear();
			seenMessageIds.clear();
			await currentPersistence?.delete();
		};
		const transition = runtimeTransition.then(clear, clear);
		runtimeTransition = transition.catch(() => undefined);
		await transition;
		return count;
	};
	const followUp = async (
		agentId: string,
		task: string,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<ManagedAgent> => {
		const generation = runtimeGeneration;
		const ownedRegistry = requireRegistry();
		const currentSettings = getCurrentSettings();
		const existing = ownedRegistry.get(agentId);
		if (!existing) throw new Error(`Unknown subagent: ${agentId}`);
		await confirmProjectAgent(
			existing.agent,
			existing.agentScope ?? "user",
			false,
			ctx,
			existing.cwd,
			currentSettings,
		);
		assertCurrentSpawn(signal, generation, runtimeGeneration);
		assertFollowUpWriteAllowed(
			ownedRegistry,
			existing,
			false,
			isolatedAgents.has(existing.id),
			currentSettings,
		);
		assertRetainedContractCompatible(existing, currentSettings);
		return ownedRegistry.followUp(agentId, task);
	};
	const interruptAgent = async (agentId: string, subtree = false): Promise<number> => {
		if (subtree) return (await requireRegistry().interruptTree(agentId)).length;
		await requireRegistry().interrupt(agentId);
		return 1;
	};
	const closeAgent = async (agentId: string, subtree = false): Promise<number> => {
		const ownedRegistry = requireRegistry();
		let count = 0;
		try {
			if (subtree) count = (await ownedRegistry.closeTree(agentId)).length;
			else {
				await ownedRegistry.close(agentId);
				count = 1;
			}
		} finally {
			await cleanupClosedWorkspaces(ownedRegistry, isolatedAgents, workspaceManager);
		}
		return count;
	};
	const assertRetainedContractCompatible = (
		existing: ManagedAgent,
		currentSettings: SubagentSettings | undefined,
	) => {
		const ceiling = dependencies.ceilings?.resolve() ?? { sources: [] };
		if (ceiling.sources.length === 0) return;
		const agent = discoverAgents(
			existing.cwd,
			existing.agentScope ?? "user",
			currentSettings,
		).agents.find((candidate) => candidate.name === existing.agent);
		if (!agent) throw new Error(`Unknown subagent: ${existing.agent}`);
		const target =
			existing.target ??
			targetPolicyAudit(
				resolveSubagentTarget({
					workspace: activeContext?.cwd ?? existing.cwd,
					requestedCwd: existing.cwd,
					currentProjectTrusted: activeContext?.isProjectTrusted() ?? false,
				}),
			);
		const contract = resolveLaunchContract({
			agent,
			agentScope: existing.agentScope ?? "user",
			target,
			thinkingLevel: existing.thinkingLevel ?? agent.thinkingLevel,
			timeoutMs: agent.timeoutMs ?? resolveDefaultSubagentTimeoutMs(),
			transport: transportKind,
			evidence: existing.evidencePolicy,
			disableExtensions: transportKind === "in-process",
			ceiling,
		});
		const previousTools = existing.capabilityTools ?? agent.tools;
		const currentTools = contract.effectiveTools;
		const toolsNarrowed =
			previousTools === undefined
				? currentTools !== undefined
				: currentTools !== undefined && previousTools.some((tool) => !currentTools.includes(tool));
		const previousDisableExtensions = existing.disableExtensions ?? contract.disableExtensions;
		const extensionsNarrowed = contract.disableExtensions && !previousDisableExtensions;
		if (toolsNarrowed || extensionsNarrowed) {
			throw new Error(
				"The active capability ceiling narrows this retained agent; create a new compliant agent",
			);
		}
	};
	const controller: StatefulSubagentController = {
		getCompletionDelivery() {
			return completionDelivery;
		},
		setCompletionDelivery(value) {
			completionDelivery = value;
			completionBroker?.setDelivery(value);
			refreshSpawnToolRegistration?.();
		},
		setAgentCatalog(value) {
			agentCatalog = value;
			refreshSpawnToolRegistration?.();
		},
		refreshSettingsGuidance() {
			refreshSpawnToolRegistration?.();
		},
		getRuntimeStatus() {
			const counts = registry?.inspectionCounts() ?? { activeAgents: 0, retainedAgents: 0 };
			return {
				enabled,
				initialized: registry !== undefined,
				transport: transportKind,
				completionDelivery,
				limits: { ...runtimeLimits },
				...counts,
			};
		},
		getFleetView() {
			return fleetView;
		},
		getLifecycleArtifactStatus() {
			return artifactWriter?.status() ?? disabledLifecycleArtifactStatus();
		},
		listAgents(includeClosed = false) {
			return registry?.list(includeClosed) ?? [];
		},
		listRunInspection(includeClosed = false) {
			return registry?.listInspection(includeClosed) ?? [];
		},
		getRunInspection(agentId) {
			return registry?.getInspection(agentId);
		},
		setFleetView(value) {
			const previous = fleetView;
			fleetView = value;
			try {
				refreshFleet();
			} catch (error) {
				fleetView = previous;
				try {
					refreshFleet();
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						"Failed to apply and roll back FleetView",
					);
				}
				throw error;
			}
		},
		followUp,
		async queueMessage(agentId, message) {
			await requireRegistry().sendMessage(agentId, message);
		},
		interruptAgent,
		closeAgent,
		clearAgents,
	};
	if (!enabled) return controller;

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++runtimeGeneration;
		clearFleetBestEffort(activeContext);
		activeContext = ctx;
		artifactWriter?.close();
		artifactWriter = undefined;
		completionBroker?.close();
		completionBroker = undefined;
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;
		const previousRegistry = registry;
		registry = undefined;
		persistence = undefined;
		isolatedAgents.clear();
		seenMessageIds.clear();
		const initialize = async () => {
			const cleanupErrors = await disposeStatefulRuntime(previousRegistry, workspaceManager);
			if (generation !== runtimeGeneration) return;
			if (cleanupErrors.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Previous subagent runtime cleanup reported ${cleanupErrors.length} error(s).`,
					"warning",
				);
			}
			parentRuntime.model = ctx.model;
			parentRuntime.thinkingLevel = normalizeRuntimeThinkingLevel(pi.getThinkingLevel());
			const sessionSettings = getCurrentStatefulSettings();
			const nextLimits = resolveStatefulLimits(sessionSettings);
			const owner =
				ctx.sessionManager.getSessionId?.() ??
				ctx.sessionManager.getSessionFile?.() ??
				`ephemeral:${ctx.cwd}`;
			const sessionPersistence = new AgentPersistence(owner, {
				retentionDays: sessionSettings.retentionDays,
				maxStoredAgents: nextLimits.maxStoredAgents,
			});
			const sessionArtifactWriter =
				sessionSettings.lifecycleArtifacts === "metadata"
					? new LifecycleArtifactWriter(
							owner,
							sessionSettings.retentionDays,
							undefined,
							() => generation === runtimeGeneration,
						)
					: undefined;
			await sessionArtifactWriter?.cleanupExpired();
			if (generation !== runtimeGeneration) {
				sessionArtifactWriter?.close();
				return;
			}
			const sessionBroker = new CompletionDeliveryBroker(pi, ctx, completionDelivery, {
				onDeliveryError: (error) => {
					if (!ctx.hasUI) return;
					const reason = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Subagent completion delivery failed: ${reason}`, "warning");
				},
			});
			const transport =
				transportKind === "in-process"
					? new InProcessTransport({
							modelRegistry: ctx.modelRegistry,
							getParentRuntime: () => ({ ...parentRuntime }),
							createSession: dependencies.createInProcessSession,
							discoverAgent: (agent) => {
								const candidate = discoverAgents(
									agent.cwd,
									agent.agentScope ?? "user",
									getCurrentSettings(),
								).agents.find((entry) => entry.name === agent.agent);
								return candidate && agent.capabilityTools
									? { ...candidate, tools: [...agent.capabilityTools] }
									: candidate;
							},
						})
					: new SubprocessTransport({ getSettings: getCurrentSettings });
			const nextRegistry = new AgentRegistry(transport, {
				maxAgents: nextLimits.maxAgents,
				maxActiveTurns: nextLimits.maxActiveTurns,
				maxDepth: nextLimits.maxDepth,
				maxChildrenPerAgent: nextLimits.maxChildrenPerAgent,
				maxMailboxMessages: sessionSettings.maxMailboxMessages,
				maxMailboxMessageBytes: sessionSettings.maxMailboxMessageBytes,
				idleTtlMs: sessionSettings.idleTtlMs,
				onChange: async (agents) => {
					await sessionPersistence.save(agents);
					if (generation !== runtimeGeneration) return;
					await sessionArtifactWriter?.publish(agents);
					if (generation !== runtimeGeneration) return;
					try {
						refreshFleet(agents);
					} catch (error) {
						fleetView = "off";
						clearFleetBestEffort(ctx);
						if (ctx.hasUI) {
							const reason = error instanceof Error ? error.message : String(error);
							ctx.ui.notify(`Subagent FleetView was disabled: ${reason}`, "warning");
						}
					}
					for (const agent of agents) {
						for (const message of agent.mailbox) {
							if (seenMessageIds.has(message.id)) continue;
							seenMessageIds.add(message.id);
							pi.appendEntry("pi-subagent-message", {
								senderId: message.senderId,
								recipientId: message.recipientId,
								content: redactPrivateText(message.content).slice(0, 160),
							});
						}
					}
				},
				onTurnComplete: (completion) => {
					if (generation === runtimeGeneration) sessionBroker.enqueue(completion);
				},
			});
			const restored = sessionPersistence
				.load()
				.filter(
					(agent) =>
						agent.workspaceMode !== "worktree" &&
						((agent.agentScope !== "project" && agent.agentScope !== "both") ||
							ctx.isProjectTrusted()),
				)
				.flatMap((agent) => {
					try {
						const target = resolveSubagentTarget({
							workspace: ctx.cwd,
							requestedCwd: agent.cwd,
							currentProjectTrusted: ctx.isProjectTrusted(),
						});
						return [{ ...agent, cwd: target.cwd, target: targetPolicyAudit(target) }];
					} catch {
						return [];
					}
				});
			for (const agent of restored) {
				for (const message of agent.mailbox) seenMessageIds.add(message.id);
			}
			nextRegistry.restore(restored);
			if (generation !== runtimeGeneration) {
				sessionBroker.close();
				sessionArtifactWriter?.close();
				await disposeStatefulRuntime(nextRegistry, workspaceManager);
				return;
			}
			await sessionArtifactWriter?.publish(nextRegistry.list());
			if (generation !== runtimeGeneration) {
				sessionBroker.close();
				sessionArtifactWriter?.close();
				await disposeStatefulRuntime(nextRegistry, workspaceManager);
				return;
			}
			registry = nextRegistry;
			persistence = sessionPersistence;
			artifactWriter = sessionArtifactWriter;
			completionBroker = sessionBroker;
			runtimeLimits = nextLimits;
			fleetView = sessionSettings.fleetView ?? fleetView;
			refreshSpawnToolRegistration?.();
			try {
				refreshFleet(nextRegistry.list());
			} catch (error) {
				fleetView = "off";
				clearFleetBestEffort(ctx);
				if (ctx.hasUI) {
					const reason = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Subagent FleetView was disabled: ${reason}`, "warning");
				}
			}
			const sweepEveryMs = Math.max(
				1_000,
				Math.min(sessionSettings.idleTtlMs ?? 60 * 60 * 1000, 60_000),
			);
			sweepTimer = setInterval(() => {
				void nextRegistry.sweepExpired().catch((error: unknown) => {
					if (!ctx.hasUI || generation !== runtimeGeneration) return;
					const reason = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Subagent expiry cleanup failed: ${reason}`, "warning");
				});
			}, sweepEveryMs);
			sweepTimer.unref();
		};
		const transition = runtimeTransition.then(initialize, initialize);
		runtimeTransition = transition.catch(() => undefined);
		await transition;
	});

	pi.on("agent_start", () => {
		completionBroker?.onParentTurnStart();
	});

	pi.on("agent_settled", () => {
		completionBroker?.onParentSettled();
	});

	pi.on("model_select", (event) => {
		parentRuntime.model = event.model;
	});

	pi.on("thinking_level_select", (event) => {
		parentRuntime.thinkingLevel = normalizeRuntimeThinkingLevel(event.level);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtimeGeneration++;
		clearFleetBestEffort(activeContext);
		activeContext = undefined;
		artifactWriter?.close();
		artifactWriter = undefined;
		completionBroker?.close();
		completionBroker = undefined;
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;
		const previousRegistry = registry;
		registry = undefined;
		persistence = undefined;
		isolatedAgents.clear();
		seenMessageIds.clear();
		const shutdown = async () => {
			const errors = await disposeStatefulRuntime(previousRegistry, workspaceManager);
			if (errors.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Subagent shutdown cleanup reported ${errors.length} error(s).`, "warning");
			}
		};
		const transition = runtimeTransition.then(shutdown, shutdown);
		runtimeTransition = transition.catch(() => undefined);
		await transition;
	});

	const baseSpawnDescription = () =>
		`Start an addressable background subagent with an optional thinking level chosen for the task difficulty, return immediately with an agentId, and receive its completion asynchronously. Detached capacity: ${runtimeLimits.maxAgents} retained agents, ${runtimeLimits.maxActiveTurns} active turns, ${runtimeLimits.maxChildrenPerAgent} direct children per agent, and depth ${runtimeLimits.maxDepth}. Working-directory target policy: ${dependencies.getSettings?.()?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY}. This controls launch targets and protected project resources, not filesystem access or sandboxing.`;
	const spawnTool = defineTool({
		name: "subagent_spawn",
		label: "Spawn Subagent",
		description: appendAgentCatalog(baseSpawnDescription(), agentCatalog),
		promptSnippet: "Start a reusable detached subagent; completion is delivered asynchronously",
		promptGuidelines: createSpawnPromptGuidelines(completionDelivery, blockingEnabled),
		parameters: Type.Object({
			agent: Type.String({ minLength: 1 }),
			task: Type.String({ minLength: 1, maxLength: DEFAULT_MAX_CONTEXT_BYTES }),
			thinkingLevel: Type.Optional(StatefulThinkingLevelSchema),
			evidence: Type.Optional(EvidenceSchema),
			cwd: Type.Optional(Type.String()),
			agentScope: Type.Optional(ScopeSchema),
			confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
			context: Type.Optional(ContextModeSchema),
			contextEntryIds: Type.Optional(
				Type.Array(Type.String(), { description: "Optional selected session entry IDs." }),
			),
			parentId: Type.Optional(Type.String({ description: "Optional parent agent ID." })),
			allowConcurrentWrites: Type.Optional(
				Type.Boolean({ description: "Override the shared-workspace write conflict guard." }),
			),
			workspaceMode: Type.Optional(
				StringEnum(["shared", "worktree"] as const, {
					description: "Use the shared workspace or an opt-in disposable Git worktree.",
				}),
			),
		}),
		...createStatefulToolRenderer("spawn"),
		async execute(_id, params, signal, _update, ctx) {
			const scope = (params.agentScope ?? "user") as AgentScope;
			assertSubagentDepthAllowed();
			const generation = runtimeGeneration;
			const currentSettings = getCurrentSettings();
			const target = resolveSubagentTarget({
				workspace: ctx.cwd,
				requestedCwd: params.cwd,
				currentProjectTrusted: ctx.isProjectTrusted(),
			});
			assertDelegationTargetAllowed(
				target,
				currentSettings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY,
			);
			const cwd = target.cwd;
			await confirmProjectAgent(
				params.agent,
				scope,
				params.confirmProjectAgents ?? true,
				ctx,
				cwd,
				currentSettings,
			);
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			const ownedRegistry = requireRegistry();
			const resolvedAgent = discoverAgents(cwd, scope, currentSettings).agents.find(
				(agent) => agent.name === params.agent,
			);
			if (!resolvedAgent) throw new Error(`Unknown subagent: ${params.agent}`);
			if (params.workspaceMode === "worktree" && resolvedAgent.source === "project") {
				throw new Error("Project-local subagent definitions cannot run in a detached worktree");
			}
			const mode = resolveSpawnContextMode(params.context, params.contextEntryIds);
			const snapshot = buildContextSnapshot(
				ctx.sessionManager.getBranch(),
				mode,
				DEFAULT_MAX_CONTEXT_BYTES,
				params.contextEntryIds,
			);
			const requestedCwd = cwd;
			if ((params.workspaceMode ?? "shared") === "shared" && !params.allowConcurrentWrites) {
				assertNoSharedWriteConflict(
					ownedRegistry,
					params.agent,
					requestedCwd,
					scope,
					currentSettings,
				);
			}
			const workspaceOwner = `pending-${randomUUID()}`;
			const workspace =
				params.workspaceMode === "worktree"
					? await workspaceManager.create(workspaceOwner, requestedCwd)
					: undefined;
			try {
				assertCurrentSpawn(signal, generation, runtimeGeneration);
			} catch (error) {
				if (workspace) await workspaceManager.cleanup(workspaceOwner);
				throw error;
			}
			const targetSnapshot = targetPolicyAudit(target);
			const contract = resolveLaunchContract({
				agent: resolvedAgent,
				agentScope: scope,
				target: targetSnapshot,
				thinkingLevel: params.thinkingLevel ?? resolvedAgent.thinkingLevel,
				timeoutMs: resolvedAgent.timeoutMs ?? resolveDefaultSubagentTimeoutMs(),
				transport: transportKind,
				evidence: params.evidence as EvidencePolicy | undefined,
				disableExtensions: transportKind === "in-process",
				ceiling: dependencies.ceilings?.resolve() ?? { sources: [] },
			});
			let agent: ManagedAgent | undefined;
			try {
				agent = await ownedRegistry.spawn({
					agent: params.agent,
					task: params.task,
					cwd: workspace?.path ?? requestedCwd,
					agentScope: scope,
					thinkingLevel: params.thinkingLevel,
					parentId: params.parentId,
					context: snapshot.text || undefined,
					contextSourceIds: snapshot.sourceIds,
					contextTruncated: snapshot.truncated,
					workspaceMode: workspace ? "worktree" : undefined,
					target: targetSnapshot,
					evidencePolicy: params.evidence as EvidencePolicy | undefined,
					launchContractDigest: contract.digest,
					capabilityTools: contract.effectiveTools,
					disableExtensions: contract.disableExtensions,
				});
				assertCurrentSpawn(signal, generation, runtimeGeneration);
			} catch (error) {
				if (agent) await ownedRegistry.closeTree(agent.id).catch(() => undefined);
				if (workspace) await workspaceManager.cleanup(workspaceOwner);
				throw error;
			}
			if (!agent) throw new Error("Subagent spawn completed without a retained agent");
			if (workspace) isolatedAgents.set(agent.id, workspaceOwner);
			const deliveryNote =
				completionDelivery === "auto-resume"
					? "If no useful local work remains, briefly tell the user what was launched and end the response; auto-resume will request synthesis after completion."
					: "End the response without the result only when the current response does not depend on it; next-turn delivery will not wake an idle root.";
			return result(
				agent,
				`Spawned ${agent.agent} as ${agent.id}. Do useful non-overlapping work immediately. ${deliveryNote} Do not poll for progress.`,
			);
		},
	});
	refreshSpawnToolRegistration = () => {
		spawnTool.description = appendAgentCatalog(baseSpawnDescription(), agentCatalog);
		spawnTool.promptGuidelines = createSpawnPromptGuidelines(completionDelivery, blockingEnabled);
		pi.registerTool(spawnTool);
	};
	refreshSpawnToolRegistration();

	pi.registerTool({
		name: "subagent_send",
		label: "Send Subagent Follow-up",
		description:
			"Send follow-up work to an idle, completed, interrupted, or failed subagent and start a new turn. Use subagent_mailbox for queue-only messages.",
		promptSnippet: "Start a new detached follow-up turn on a retained subagent",
		parameters: Type.Object({
			agentId: Type.String(),
			task: Type.String({ minLength: 1, maxLength: DEFAULT_MAX_CONTEXT_BYTES }),
			allowConcurrentWrites: Type.Optional(
				Type.Boolean({ description: "Override the shared-workspace write conflict guard." }),
			),
		}),
		...createStatefulToolRenderer("send"),
		async execute(_id, params, signal, _update, ctx) {
			const generation = runtimeGeneration;
			const ownedRegistry = requireRegistry();
			const currentSettings = getCurrentSettings();
			const existing = ownedRegistry.get(params.agentId);
			if (!existing) throw new Error(`Unknown subagent: ${params.agentId}`);
			await confirmProjectAgent(
				existing.agent,
				existing.agentScope ?? "user",
				false,
				ctx,
				existing.cwd,
				currentSettings,
			);
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			assertFollowUpWriteAllowed(
				ownedRegistry,
				existing,
				params.allowConcurrentWrites ?? false,
				isolatedAgents.has(existing.id),
				currentSettings,
			);
			assertRetainedContractCompatible(existing, currentSettings);
			const agent = await ownedRegistry.followUp(params.agentId, params.task);
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			return result(agent, `Started follow-up for ${agent.id}.`);
		},
	});

	pi.registerTool({
		name: "subagent_manage",
		label: "Manage Subagents",
		description:
			"List retained subagents through the compatibility route, interrupt active work while keeping an agent reusable, or close agents and release their resources. Prefer subagent_inspect when the whole activated capability must be read-only.",
		promptSnippet: "List or control retained detached subagents",
		parameters: ManageParamsSchema,
		...createStatefulToolRenderer("manage"),
		async execute(_id, params): Promise<StatefulActionToolResult> {
			const operation = validateManageParams(params);
			if (operation.action === "list") {
				const agents = requireRegistry().list(operation.includeClosed);
				return {
					content: [
						{
							type: "text",
							text: agents.length ? agents.map(formatLine).join("\n") : "No stateful subagents.",
						},
					],
					details: { agents: agents.map(summarizeStatefulAgent) },
				};
			}
			const agentId = operation.agentId;
			if (operation.action === "interrupt") {
				if (operation.subtree) {
					const agents = await requireRegistry().interruptTree(agentId);
					return {
						content: [{ type: "text", text: `Interrupted ${agents.length} active agent(s).` }],
						details: {
							agent: summarizeStatefulAgent(requireAgent(agentId)),
							agents: agents.map(summarizeStatefulAgent),
						},
					};
				}
				const agent = await requireRegistry().interrupt(agentId);
				return result(agent, `Interrupted ${agent.id}; it remains reusable.`);
			}
			const existing = requireRegistry().get(agentId);
			if (existing?.state === "closed" && !operation.subtree) {
				const pendingOwner = isolatedAgents.get(existing.id);
				if (pendingOwner) await workspaceManager.cleanup(pendingOwner);
				isolatedAgents.delete(existing.id);
				return result(existing, `Closed ${existing.id}.`);
			}
			if (operation.subtree) {
				let agents: ManagedAgent[];
				try {
					agents = await requireRegistry().closeTree(agentId);
				} finally {
					await cleanupClosedWorkspaces(requireRegistry(), isolatedAgents, workspaceManager);
				}
				return {
					content: [{ type: "text", text: `Closed ${agents.length} agent(s).` }],
					details: {
						agent: summarizeStatefulAgent(requireAgent(agentId)),
						agents: agents.map(summarizeStatefulAgent),
					},
				};
			}
			let agent: ManagedAgent;
			try {
				agent = await requireRegistry().close(agentId);
			} finally {
				await cleanupClosedWorkspaces(requireRegistry(), isolatedAgents, workspaceManager);
			}
			return result(agent, `Closed ${agent.id}.`);
		},
	});

	pi.registerTool({
		name: "subagent_mailbox",
		label: "Subagent Mailbox",
		description:
			"Queue a bounded message without starting a turn, or read unread mailbox messages. Read acknowledges returned messages by default; use subagent_inspect for metadata-only unread counts.",
		promptSnippet: "Send or read queue-only detached-subagent mailbox messages",
		parameters: MailboxParamsSchema,
		...createStatefulToolRenderer("mailbox"),
		async execute(_id, params): Promise<StatefulActionToolResult> {
			const operation = validateMailboxParams(params);
			if (operation.action === "send") {
				const message = await requireRegistry().sendMessage(
					operation.agentId,
					operation.message,
					operation.senderId,
					operation.deduplicationKey,
				);
				return {
					content: [{ type: "text", text: `Queued ${message.id} for ${message.recipientId}.` }],
					details: { message },
				};
			}
			const messages = await requireRegistry().readMessages(
				operation.agentId,
				operation.acknowledge,
				operation.limit,
			);
			const summaries = messages.map((message) => ({
				...message,
				content: truncateUtf8(message.content, MAX_TOOL_MESSAGE_BYTES).text,
			}));
			const text = summaries.length
				? summaries
						.map((message) => `${message.id} from ${message.senderId}: ${message.content}`)
						.join("\n")
				: "No unread messages.";
			return {
				content: [{ type: "text", text: truncateUtf8(text, DEFAULT_MAX_CONTEXT_BYTES).text }],
				details: { messages: summaries },
			};
		},
	});

	return controller;
}

function normalizeContextMode(value: "none" | "all" | "summary" | number | undefined): ContextMode {
	if (value === undefined) return "none";
	if (value === "none" || value === "all" || value === "summary") return value;
	return Math.max(1, Math.floor(value));
}

export function resolveSpawnContextMode(
	value: "none" | "all" | "summary" | number | undefined,
	contextEntryIds: readonly string[] | undefined,
): ContextMode {
	if (value === undefined && contextEntryIds !== undefined) return "all";
	return normalizeContextMode(value);
}

function formatLine(agent: ManagedAgent): string {
	return formatStatefulAgentLine(agent);
}

export { buildDetachedCompletionMessage, CompletionDeliveryBroker } from "./completion-delivery.js";
export { formatStatefulAgentLine } from "./stateful-presenter.js";

async function cleanupClosedWorkspaces(
	registry: AgentRegistry,
	isolatedAgents: Map<string, string>,
	workspaceManager: WorkspaceManager,
): Promise<void> {
	for (const [agentId, owner] of [...isolatedAgents]) {
		if (registry.get(agentId)?.state !== "closed") continue;
		await workspaceManager.cleanup(owner);
		isolatedAgents.delete(agentId);
	}
}

function appendAgentCatalog(baseDescription: string, catalog: string): string {
	return catalog ? `${baseDescription}\n\n${catalog}` : baseDescription;
}

function result(agent: ManagedAgent, text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { agent: summarizeStatefulAgent(agent) },
	};
}

export function resolveStatefulTransportKind(
	value: "subprocess" | "in-process" | undefined,
): "subprocess" | "in-process" {
	return value ?? "subprocess";
}

export function resolveCompletionDelivery(
	value: CompletionDelivery | undefined,
): CompletionDelivery {
	return value ?? "next-turn";
}

function normalizeRuntimeThinkingLevel(value: string): ParentRuntimeSnapshot["thinkingLevel"] {
	return isThinkingLevel(value) ? value : "off";
}

export {
	buildStatefulTurnPrompt,
	resolveStatefulTurnTimeout,
} from "./stateful-prompt.js";
