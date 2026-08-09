import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { safeTerminalLine } from "./safe-text.js";

export type EvidencePolicy = "attested";
export type EvidenceStatus = "attested" | "missing" | "invalid";

export interface EvidenceAttestation {
	status: EvidenceStatus;
	summary?: string;
	changedFiles?: string[];
	commandsRun?: string[];
	validations?: string[];
	residualRisks?: string[];
}

const MAX_FIELD_BYTES = 2 * 1024;
const MAX_ITEMS = 32;
const MAX_JSON_BYTES = 16 * 1024;
const EVIDENCE_BLOCK = /```subagent-evidence\s*\n([\s\S]*?)\n```/gu;

export const EVIDENCE_INSTRUCTION = [
	"When finished, append exactly one fenced subagent-evidence JSON block.",
	'Use keys "summary", "changedFiles", "commandsRun", "validations", and "residualRisks".',
	"Report only what you actually did; this is an unverified attestation.",
].join(" ");

export function appendEvidenceInstruction(task: string, policy?: EvidencePolicy): string {
	if (policy !== "attested") return task;
	const suffix = `\n\n${EVIDENCE_INSTRUCTION}`;
	const taskBudget = Math.max(0, DEFAULT_MAX_CONTEXT_BYTES - Buffer.byteLength(suffix, "utf8"));
	return `${truncateUtf8(task, taskBudget).text}${suffix}`;
}

export function parseEvidenceAttestation(
	output: string,
	policy?: EvidencePolicy,
): EvidenceAttestation | undefined {
	if (policy !== "attested") return undefined;
	const matches = [...output.matchAll(EVIDENCE_BLOCK)];
	if (matches.length === 0) return { status: "missing" };
	if (matches.length !== 1) return { status: "invalid" };
	const raw = matches[0]?.[1] ?? "";
	if (Buffer.byteLength(raw, "utf8") > MAX_JSON_BYTES) return { status: "invalid" };
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { status: "invalid" };
	}
	if (!isPlainObject(value)) return { status: "invalid" };
	const allowed = new Set([
		"summary",
		"changedFiles",
		"commandsRun",
		"validations",
		"residualRisks",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) return { status: "invalid" };
	if (typeof value.summary !== "string" || !value.summary.trim()) return { status: "invalid" };
	const changedFiles = boundedStrings(value.changedFiles);
	const commandsRun = boundedStrings(value.commandsRun);
	const validations = boundedStrings(value.validations);
	const residualRisks = boundedStrings(value.residualRisks);
	if (!changedFiles || !commandsRun || !validations || !residualRisks) {
		return { status: "invalid" };
	}
	return {
		status: "attested",
		summary: bound(value.summary),
		changedFiles,
		commandsRun,
		validations,
		residualRisks,
	};
}

function boundedStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
	if (!value.every((item) => typeof item === "string")) return undefined;
	return value.map((item) => bound(item));
}

function bound(value: string): string {
	return safeTerminalLine(value, MAX_FIELD_BYTES);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
