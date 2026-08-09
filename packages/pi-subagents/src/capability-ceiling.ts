import { randomUUID } from "node:crypto";

export interface CapabilityCeiling {
	allowedAgents?: string[];
	allowedTools?: string[];
	denyExtensions?: boolean;
}

export interface EffectiveCapabilityCeiling extends CapabilityCeiling {
	sources: string[];
}

interface RegisteredCeiling {
	source: string;
	ceiling: CapabilityCeiling;
}

export interface CapabilityCeilingAuditEntry {
	operation: "register" | "update" | "dispose";
	source: string;
	at: number;
}

const MAX_PROVIDERS = 32;
const MAX_LIST_ITEMS = 256;
const MAX_NAME_LENGTH = 256;
const MAX_AUDIT_ENTRIES = 64;

export class CapabilityCeilingRegistry {
	private readonly providers = new Map<string, RegisteredCeiling>();
	private readonly auditEntries: CapabilityCeilingAuditEntry[] = [];

	register(source: string, ceiling: CapabilityCeiling): string {
		if (this.providers.size >= MAX_PROVIDERS) {
			throw new Error(`Capability ceiling provider limit reached (${MAX_PROVIDERS})`);
		}
		const normalizedSource = normalizeName(source, "Capability ceiling source");
		const token = randomUUID();
		this.providers.set(token, { source: normalizedSource, ceiling: normalizeCeiling(ceiling) });
		this.record("register", normalizedSource);
		return token;
	}

	update(token: string, ceiling: CapabilityCeiling): void {
		const provider = this.providers.get(token);
		if (!provider) throw new Error("Unknown capability ceiling token");
		provider.ceiling = normalizeCeiling(ceiling);
		this.record("update", provider.source);
	}

	dispose(token: string): boolean {
		const provider = this.providers.get(token);
		const disposed = this.providers.delete(token);
		if (provider && disposed) this.record("dispose", provider.source);
		return disposed;
	}

	clear(): void {
		this.providers.clear();
		this.auditEntries.length = 0;
	}

	audit(): CapabilityCeilingAuditEntry[] {
		return this.auditEntries.map((entry) => ({ ...entry }));
	}

	resolve(): EffectiveCapabilityCeiling {
		let allowedAgents: Set<string> | undefined;
		let allowedTools: Set<string> | undefined;
		let denyExtensions = false;
		const sources: string[] = [];
		for (const provider of this.providers.values()) {
			sources.push(provider.source);
			allowedAgents = intersect(allowedAgents, provider.ceiling.allowedAgents);
			allowedTools = intersect(allowedTools, provider.ceiling.allowedTools);
			denyExtensions ||= provider.ceiling.denyExtensions === true;
		}
		return {
			...(allowedAgents ? { allowedAgents: [...allowedAgents].sort() } : {}),
			...(allowedTools ? { allowedTools: [...allowedTools].sort() } : {}),
			...(denyExtensions ? { denyExtensions: true } : {}),
			sources: [...new Set(sources)].sort(),
		};
	}

	private record(operation: CapabilityCeilingAuditEntry["operation"], source: string): void {
		this.auditEntries.push({ operation, source, at: Date.now() });
		if (this.auditEntries.length > MAX_AUDIT_ENTRIES) {
			this.auditEntries.splice(0, this.auditEntries.length - MAX_AUDIT_ENTRIES);
		}
	}
}

export function applyCapabilityCeiling(
	agentName: string,
	configuredTools: readonly string[] | undefined,
	ceiling: EffectiveCapabilityCeiling,
): { tools?: string[]; disableExtensions?: boolean } {
	if (ceiling.allowedAgents && !ceiling.allowedAgents.includes(agentName)) {
		throw new Error(`Subagent ${agentName} is denied by the active capability ceiling`);
	}
	let tools = configuredTools ? [...new Set(configuredTools)] : undefined;
	if (ceiling.allowedTools) {
		tools = tools
			? tools.filter((tool) => ceiling.allowedTools?.includes(tool))
			: [...ceiling.allowedTools];
	}
	return {
		...(tools ? { tools } : {}),
		...(ceiling.denyExtensions ? { disableExtensions: true } : {}),
	};
}

function normalizeCeiling(value: CapabilityCeiling): CapabilityCeiling {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Capability ceiling must be an object");
	}
	if (
		Object.keys(value).some(
			(key) => !["allowedAgents", "allowedTools", "denyExtensions"].includes(key),
		)
	) {
		throw new Error("Capability ceiling contains an unsupported field");
	}
	if (value.denyExtensions !== undefined && typeof value.denyExtensions !== "boolean") {
		throw new Error("denyExtensions must be boolean");
	}
	return {
		...(value.allowedAgents !== undefined
			? { allowedAgents: normalizeList(value.allowedAgents, "allowedAgents") }
			: {}),
		...(value.allowedTools !== undefined
			? { allowedTools: normalizeList(value.allowedTools, "allowedTools") }
			: {}),
		...(value.denyExtensions !== undefined
			? { denyExtensions: value.denyExtensions === true }
			: {}),
	};
}

function normalizeList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
		throw new Error(`${label} must be an array with at most ${MAX_LIST_ITEMS} items`);
	}
	return [...new Set(value.map((item) => normalizeName(item, label)))];
}

function normalizeName(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > MAX_NAME_LENGTH) {
		throw new Error(
			`${label} entries must be non-empty strings up to ${MAX_NAME_LENGTH} characters`,
		);
	}
	return value.trim();
}

function intersect(
	current: Set<string> | undefined,
	next: string[] | undefined,
): Set<string> | undefined {
	if (next === undefined) return current;
	const nextSet = new Set(next);
	return current === undefined
		? nextSet
		: new Set([...current].filter((item) => nextSet.has(item)));
}
