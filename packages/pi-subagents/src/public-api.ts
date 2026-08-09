import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentScope, SubagentThinkingLevel } from "./agents.js";
import type { CapabilityCeiling, CapabilityCeilingRegistry } from "./capability-ceiling.js";
import type { EvidencePolicy } from "./evidence.js";
import type { LaunchContract } from "./launch-contract.js";
import type { LifecycleArtifactStatus } from "./lifecycle-artifacts.js";
import { safeTerminalLine } from "./safe-text.js";

export const PI_SUBAGENTS_V1 = "pi-subagents:v1";
export const PI_SUBAGENTS_V1_REQUEST = `${PI_SUBAGENTS_V1}:request`;
export const PI_SUBAGENTS_V1_REPLY = `${PI_SUBAGENTS_V1}:reply`;
export const PI_SUBAGENTS_V1_PROGRESS = `${PI_SUBAGENTS_V1}:progress`;
export const PI_SUBAGENTS_V1_READY = `${PI_SUBAGENTS_V1}:ready`;

export type PiSubagentsV1Method =
	| "ping"
	| "preflight"
	| "delegate"
	| "cancel"
	| "ceiling.register"
	| "ceiling.update"
	| "ceiling.dispose";

export interface PiSubagentsV1LeafPayload {
	agent: string;
	task?: string;
	cwd?: string;
	agentScope?: AgentScope;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs?: number;
	evidence?: EvidencePolicy;
	confirmProjectAgents?: boolean;
}

export interface PiSubagentsV1PreflightResult extends LaunchContract {
	projectAgentConfirmationRequired: boolean;
	lifecycleArtifact: LifecycleArtifactStatus;
}

export interface PiSubagentsV1CancelPayload {
	targetRequestId: string;
}

export interface PiSubagentsV1CeilingRegisterPayload {
	source: string;
	ceiling: CapabilityCeiling;
}

export interface PiSubagentsV1CeilingUpdatePayload {
	token: string;
	ceiling: CapabilityCeiling;
}

export interface PiSubagentsV1CeilingDisposePayload {
	token: string;
}

export interface PiSubagentsV1Progress {
	requestId: string;
	state: "running";
}

export interface PiSubagentsV1Ready {
	protocol: typeof PI_SUBAGENTS_V1;
}

export interface PiSubagentsV1Request {
	requestId: string;
	method: PiSubagentsV1Method;
	payload?: unknown;
}

export interface PiSubagentsV1Reply {
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string };
}

export interface PublicApiDependencies {
	preflight(payload: unknown, ctx: ExtensionContext): Promise<unknown> | unknown;
	delegate(payload: unknown, signal: AbortSignal, ctx: ExtensionContext): Promise<unknown>;
	status?(): unknown;
}

const METHODS = new Set<PiSubagentsV1Method>([
	"ping",
	"preflight",
	"delegate",
	"cancel",
	"ceiling.register",
	"ceiling.update",
	"ceiling.dispose",
]);
const MAX_SETTLED_REQUESTS = 1024;

export function registerPiSubagentsV1Api(
	pi: ExtensionAPI,
	ceilings: CapabilityCeilingRegistry,
	dependencies: PublicApiDependencies,
): void {
	let generation = 0;
	let disposeRequest: (() => void) | undefined;
	let currentContext: ExtensionContext | undefined;
	const active = new Map<string, AbortController>();
	const settled = new Set<string>();
	const settledOrder: string[] = [];

	const rememberSettled = (requestId: string) => {
		settled.add(requestId);
		settledOrder.push(requestId);
		while (settledOrder.length > MAX_SETTLED_REQUESTS) {
			const removed = settledOrder.shift();
			if (removed) settled.delete(removed);
		}
	};
	const reply = (value: PiSubagentsV1Reply) => {
		if (settled.has(value.requestId)) return;
		rememberSettled(value.requestId);
		pi.events.emit(PI_SUBAGENTS_V1_REPLY, value);
	};
	const fail = (requestId: string, code: string, error: unknown) => {
		reply({ requestId, ok: false, error: { code, message: safeMessage(error) } });
	};
	const reset = () => {
		generation += 1;
		disposeRequest?.();
		disposeRequest = undefined;
		for (const controller of active.values()) controller.abort();
		active.clear();
		settled.clear();
		settledOrder.length = 0;
		ceilings.clear();
		currentContext = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		reset();
		currentContext = ctx;
		const boundGeneration = generation;
		disposeRequest = pi.events.on(PI_SUBAGENTS_V1_REQUEST, (raw) => {
			const parsed = parseRequest(raw);
			if (!parsed.ok) {
				if (parsed.requestId) fail(parsed.requestId, "invalid_request", parsed.error);
				return;
			}
			const request = parsed.request;
			if (active.has(request.requestId) || settled.has(request.requestId)) {
				active.get(request.requestId)?.abort();
				fail(request.requestId, "duplicate_request", "Request ID was already used");
				return;
			}
			if (!currentContext || boundGeneration !== generation) {
				fail(request.requestId, "no_session", "No current pi-subagents session");
				return;
			}
			if (request.method === "cancel") {
				try {
					assertOnlyFields(request.payload, ["targetRequestId"]);
					const targetRequestId = requiredStringField(request.payload, "targetRequestId");
					const target = active.get(targetRequestId);
					if (target) target.abort();
					reply({
						requestId: request.requestId,
						ok: true,
						result: { cancelled: target !== undefined },
					});
				} catch (error) {
					fail(request.requestId, "invalid_request", error);
				}
				return;
			}
			const controller = new AbortController();
			active.set(request.requestId, controller);
			void Promise.resolve()
				.then(async () => {
					if (boundGeneration !== generation || controller.signal.aborted) {
						throw abortError();
					}
					let result: unknown;
					switch (request.method) {
						case "ping":
							if (request.payload !== undefined) {
								throw new Error("ping does not accept a payload");
							}
							result = {
								protocol: PI_SUBAGENTS_V1,
								methods: [...METHODS],
								ceiling: ceilings.resolve(),
								ceilingAudit: ceilings.audit(),
								status: dependencies.status?.(),
							};
							break;
						case "preflight":
							result = await dependencies.preflight(request.payload, ctx);
							break;
						case "delegate":
							pi.events.emit(PI_SUBAGENTS_V1_PROGRESS, {
								requestId: request.requestId,
								state: "running",
							});
							result = await dependencies.delegate(request.payload, controller.signal, ctx);
							break;
						case "ceiling.register": {
							const payload = requiredObject(request.payload);
							assertOnlyFields(payload, ["source", "ceiling"]);
							const source = requiredStringField(payload, "source");
							const token = ceilings.register(source, requiredCeiling(payload.ceiling));
							result = { token, ceiling: ceilings.resolve() };
							break;
						}
						case "ceiling.update": {
							const payload = requiredObject(request.payload);
							assertOnlyFields(payload, ["token", "ceiling"]);
							ceilings.update(
								requiredStringField(payload, "token"),
								requiredCeiling(payload.ceiling),
							);
							result = { ceiling: ceilings.resolve() };
							break;
						}
						case "ceiling.dispose": {
							const payload = requiredObject(request.payload);
							assertOnlyFields(payload, ["token"]);
							result = {
								disposed: ceilings.dispose(requiredStringField(payload, "token")),
								ceiling: ceilings.resolve(),
							};
							break;
						}
						default:
							throw new Error("Unsupported method");
					}
					if (boundGeneration !== generation || controller.signal.aborted) {
						throw abortError();
					}
					reply({ requestId: request.requestId, ok: true, result });
				})
				.catch((error) => {
					if (boundGeneration !== generation) return;
					fail(
						request.requestId,
						controller.signal.aborted ? "cancelled" : "request_failed",
						error,
					);
				})
				.finally(() => {
					if (active.get(request.requestId) === controller) {
						active.delete(request.requestId);
					}
					if (boundGeneration === generation && !settled.has(request.requestId)) {
						rememberSettled(request.requestId);
					}
				});
		});
		pi.events.emit(PI_SUBAGENTS_V1_READY, { protocol: PI_SUBAGENTS_V1 });
	});

	pi.on("session_shutdown", () => reset());
}

function parseRequest(
	value: unknown,
): { ok: true; request: PiSubagentsV1Request } | { ok: false; requestId?: string; error: string } {
	if (!isPlainObject(value)) return { ok: false, error: "Request must be an object" };
	const requestId = typeof value.requestId === "string" ? value.requestId : undefined;
	if (!requestId || requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(requestId)) {
		return { ok: false, requestId, error: "Invalid requestId" };
	}
	if (typeof value.method !== "string" || !METHODS.has(value.method as PiSubagentsV1Method)) {
		return { ok: false, requestId, error: "Unsupported method" };
	}
	if (Object.keys(value).some((key) => !["requestId", "method", "payload"].includes(key))) {
		return { ok: false, requestId, error: "Unknown request field" };
	}
	return {
		ok: true,
		request: {
			requestId,
			method: value.method as PiSubagentsV1Method,
			...(Object.hasOwn(value, "payload") ? { payload: value.payload } : {}),
		},
	};
}

function requiredObject(value: unknown): Record<string, unknown> {
	if (!isPlainObject(value)) throw new Error("Payload must be an object");
	return value;
}

function assertOnlyFields(value: unknown, allowed: readonly string[]): void {
	const object = requiredObject(value);
	if (Object.keys(object).some((key) => !allowed.includes(key))) {
		throw new Error("Payload contains an unsupported field");
	}
}

function requiredStringField(value: unknown, field: string): string {
	const object = requiredObject(value);
	const candidate = object[field];
	if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 256) {
		throw new Error(`${field} must be a non-empty bounded string`);
	}
	return candidate;
}

function requiredCeiling(value: unknown): CapabilityCeiling {
	if (!isPlainObject(value)) throw new Error("ceiling must be an object");
	return value as CapabilityCeiling;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(value: unknown): string {
	return safeTerminalLine(value instanceof Error ? value.message : String(value), 1024);
}

function abortError(): Error {
	const error = new Error("pi-subagents request was cancelled");
	error.name = "AbortError";
	return error;
}
