import { createHash } from "node:crypto";
import type { AgentConfig, AgentScope, SubagentThinkingLevel } from "./agents.js";
import { applyCapabilityCeiling, type EffectiveCapabilityCeiling } from "./capability-ceiling.js";
import type { TargetPolicyAudit } from "./cwd-policy.js";
import type { EvidencePolicy } from "./evidence.js";
import type { ChildLaunchPolicy } from "./runner.js";

export interface LaunchContract {
	agent: string;
	agentSource: AgentConfig["source"];
	agentScope: AgentScope;
	cwd: string;
	target: TargetPolicyAudit;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs: number;
	configuredTools?: string[];
	effectiveTools?: string[];
	disableExtensions: boolean;
	disableSkills: boolean;
	disablePromptTemplates: boolean;
	disableContextFiles: boolean;
	transport: "subprocess" | "in-process";
	evidence?: EvidencePolicy;
	ceilingSources: string[];
	digest: string;
}

export interface ResolveLaunchContractOptions {
	agent: AgentConfig;
	agentScope: AgentScope;
	target: TargetPolicyAudit;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs: number;
	transport: "subprocess" | "in-process";
	evidence?: EvidencePolicy;
	disableExtensions?: boolean;
	disableSkills?: boolean;
	disablePromptTemplates?: boolean;
	disableContextFiles?: boolean;
	ceiling: EffectiveCapabilityCeiling;
}

export function resolveLaunchContract(options: ResolveLaunchContractOptions): LaunchContract {
	const constrained = applyCapabilityCeiling(
		options.agent.name,
		options.agent.tools,
		options.ceiling,
	);
	const projection = {
		agent: options.agent.name,
		agentSource: options.agent.source,
		agentScope: options.agentScope,
		cwd: options.target.cwd,
		target: cloneTarget(options.target),
		...(options.agent.model ? { model: options.agent.model } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		timeoutMs: options.timeoutMs,
		...(options.agent.tools ? { configuredTools: [...options.agent.tools] } : {}),
		...(constrained.tools ? { effectiveTools: [...constrained.tools] } : {}),
		disableExtensions: options.disableExtensions === true || constrained.disableExtensions === true,
		disableSkills: options.disableSkills === true,
		disablePromptTemplates: options.disablePromptTemplates === true,
		disableContextFiles: options.disableContextFiles === true,
		transport: options.transport,
		...(options.evidence ? { evidence: options.evidence } : {}),
		ceilingSources: [...options.ceiling.sources],
	};
	return { ...projection, digest: digestContract(projection) };
}

export function launchPolicyFromContract(contract: LaunchContract): ChildLaunchPolicy {
	return {
		projectTrust: contract.target.trust.projectTrusted,
		...(contract.effectiveTools ? { tools: [...contract.effectiveTools] } : {}),
		...(contract.disableExtensions ? { disableExtensions: true } : {}),
		...(contract.disableSkills ? { disableSkills: true } : {}),
		...(contract.disablePromptTemplates ? { disablePromptTemplates: true } : {}),
		...(contract.disableContextFiles ? { disableContextFiles: true } : {}),
	};
}

function digestContract(value: Omit<LaunchContract, "digest">): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function cloneTarget(target: TargetPolicyAudit): TargetPolicyAudit {
	return { ...target, trust: { ...target.trust } };
}
