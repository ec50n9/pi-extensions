import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompletionDelivery } from "./agents.js";
import { redactPrivateText } from "./context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import type { AgentTurnCompletion } from "./registry.js";

const MAX_TOOL_MESSAGE_BYTES = 2 * 1024;
const MAX_COMPLETION_ERROR_BYTES = 512;
const MAX_COMPLETIONS_PER_MESSAGE = 16;
const COMPLETION_BATCH_DELAY_MS = 10;

interface CompletionMetadata {
	agentId: string;
	agent: string;
	state: string;
}

interface CompletionMessage {
	customType: "pi-subagent-completion";
	content: string;
	display: true;
	details:
		| CompletionMetadata
		| {
				completionCount: number;
				completions: CompletionMetadata[];
		  };
}

type CompletionContext = Pick<ExtensionContext, "hasPendingMessages" | "isIdle">;
type CompletionPi = Pick<ExtensionAPI, "sendMessage">;

export interface CompletionDeliveryBrokerOptions {
	onDeliveryError?: (error: unknown) => void;
}

/**
 * Coalesces detached completions so one bounded notification batch starts at
 * most one root synthesis turn. The broker belongs to one parent session and
 * must be closed when that session is replaced or shut down.
 */
export class CompletionDeliveryBroker {
	private pending: AgentTurnCompletion[] = [];
	private flushTimer?: NodeJS.Timeout;
	private wakeInFlight = false;
	private closed = false;

	constructor(
		private readonly pi: CompletionPi,
		private readonly ctx: CompletionContext,
		private delivery: CompletionDelivery,
		private readonly options: CompletionDeliveryBrokerOptions = {},
	) {}

	enqueue(completion: AgentTurnCompletion): void {
		if (this.closed) return;
		this.pending.push(completion);
		this.scheduleFlush();
	}

	setDelivery(value: CompletionDelivery): void {
		this.delivery = value;
		this.scheduleFlush();
	}

	onParentTurnStart(): void {
		this.wakeInFlight = false;
		this.scheduleFlush();
	}

	onParentSettled(): void {
		this.wakeInFlight = false;
		this.scheduleFlush();
	}

	flush(): void {
		if (this.closed || this.pending.length === 0) return;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.delivery === "auto-resume" && !this.isRootIdle()) return;

		const completions = this.pending.splice(0);
		const batches = chunkCompletions(completions);
		let canWake = this.shouldWakeRoot();
		for (let index = 0; index < batches.length; index++) {
			const triggerTurn = canWake && index === batches.length - 1;
			const message = buildCompletionMessage(batches[index]);
			if (triggerTurn) this.wakeInFlight = true;
			try {
				this.pi.sendMessage(message, { deliverAs: "steer", triggerTurn });
			} catch (primaryError) {
				if (triggerTurn) this.wakeInFlight = false;
				canWake = false;
				try {
					this.pi.sendMessage(message, { deliverAs: "nextTurn", triggerTurn: false });
				} catch (fallbackError) {
					this.pending = [...batches.slice(index).flat(), ...this.pending];
					try {
						this.options.onDeliveryError?.(
							new AggregateError(
								[primaryError, fallbackError],
								"Detached subagent completion delivery failed",
							),
						);
					} catch {
						// Delivery retention must survive a failing observer.
					}
					return;
				}
			}
		}
	}

	close(): void {
		this.closed = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.pending = [];
	}

	private scheduleFlush(): void {
		if (this.closed || this.pending.length === 0 || this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, COMPLETION_BATCH_DELAY_MS);
	}

	private isRootIdle(): boolean {
		try {
			return this.ctx.isIdle();
		} catch {
			return false;
		}
	}

	private shouldWakeRoot(): boolean {
		if (this.delivery !== "auto-resume" || this.wakeInFlight) return false;
		try {
			return !this.ctx.hasPendingMessages();
		} catch {
			return false;
		}
	}
}

function chunkCompletions(completions: AgentTurnCompletion[]): AgentTurnCompletion[][] {
	const batches: AgentTurnCompletion[][] = [];
	for (let index = 0; index < completions.length; index += MAX_COMPLETIONS_PER_MESSAGE) {
		batches.push(completions.slice(index, index + MAX_COMPLETIONS_PER_MESSAGE));
	}
	return batches;
}

function buildCompletionMessage(completions: AgentTurnCompletion[]): CompletionMessage {
	if (completions.length === 1) {
		const completion = completions[0];
		return {
			customType: "pi-subagent-completion",
			content: buildDetachedCompletionMessage(completion),
			display: true,
			details: completionMetadata(completion),
		};
	}
	const content = truncateUtf8(
		[
			"Message Type: SUBAGENT_COMPLETION_BATCH",
			`Completion Count: ${completions.length}`,
			...completions.flatMap((completion, index) => [
				"",
				`--- Completion ${index + 1} of ${completions.length} ---`,
				buildDetachedCompletionMessage(completion),
			]),
		].join("\n"),
		DEFAULT_MAX_CONTEXT_BYTES,
	).text;
	return {
		customType: "pi-subagent-completion",
		content,
		display: true,
		details: {
			completionCount: completions.length,
			completions: completions.map(completionMetadata),
		},
	};
}

function completionMetadata(completion: AgentTurnCompletion): CompletionMetadata {
	return {
		agentId: completion.agent.id,
		agent: completion.agent.agent,
		state: completion.agent.state,
	};
}

export function buildDetachedCompletionMessage(completion: AgentTurnCompletion): string {
	const task = sanitizeCompletionLine(completion.task, 256) || "(unknown task)";
	const agentName = sanitizeCompletionLine(completion.agent.agent, 128) || "(unknown agent)";
	const output = redactPrivateText(completion.output);
	const error = completion.error
		? truncateUtf8(redactPrivateText(completion.error), MAX_COMPLETION_ERROR_BYTES).text
		: "";
	return truncateUtf8(
		[
			"Message Type: SUBAGENT_COMPLETION",
			`Agent ID: ${completion.agent.id}`,
			`Agent: ${agentName}`,
			`Task: ${task}`,
			`State: ${completion.agent.state}`,
			...(error.trim() ? ["Error:", error] : []),
			"Payload:",
			output.trim() ? output : "(no output)",
		].join("\n"),
		MAX_TOOL_MESSAGE_BYTES,
	).text;
}

function sanitizeCompletionLine(value: string, maxBytes: number): string {
	return (
		truncateUtf8(redactPrivateText(value), maxBytes)
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip untrusted terminal controls.
			.text.replace(/[\u0000-\u001f\u007f]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}
