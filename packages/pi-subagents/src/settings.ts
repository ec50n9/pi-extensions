import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import {
	type AgentConfig,
	CONSULT_RESOURCE_POLICIES,
	CONSULTATION_CWD_POLICIES,
	type CompletionDelivery,
	type ConsultationCwdPolicy,
	type ConsultResourcePolicy,
	DELEGATION_CWD_POLICIES,
	type DelegationCwdPolicy,
	type FleetViewMode,
	isThinkingLevel,
	type LifecycleArtifactsMode,
	type SubagentAgentConfig,
	type SubagentSettings,
	type SubagentThinkingLevel,
} from "./agents.js";
import {
	DEFAULT_MAX_PARALLEL_TASKS,
	MAX_CONFIGURABLE_PARALLEL_TASKS,
	MAX_SUBAGENT_TIMEOUT_MS,
} from "./limits.js";
import {
	isValidStatefulLimit,
	resolveStatefulLimits,
	STATEFUL_LIMIT_FIELDS,
	type StatefulLimitField,
	type StatefulLimits,
	statefulLimitDefinition,
} from "./stateful-limits.js";

export function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function isPositiveInteger(value: unknown): value is number {
	return isPositiveNumber(value) && Number.isSafeInteger(value);
}

export function normalizeAgentSettings(value: unknown): SubagentAgentConfig | undefined {
	if (!isPlainObject(value)) return undefined;

	const config: SubagentAgentConfig = {};
	let hasKnownField = false;

	if (hasOwn(value, "tools")) {
		if (!isStringArray(value.tools)) return undefined;
		config.tools = value.tools;
		hasKnownField = true;
	}

	if (hasOwn(value, "model")) {
		if (value.model !== null && typeof value.model !== "string") return undefined;
		config.model = value.model;
		hasKnownField = true;
	}

	if (hasOwn(value, "thinkingLevel")) {
		if (value.thinkingLevel !== null && !isThinkingLevel(value.thinkingLevel)) return undefined;
		config.thinkingLevel = value.thinkingLevel;
		hasKnownField = true;
	}

	if (hasOwn(value, "timeoutMs")) {
		if (
			value.timeoutMs !== null &&
			(!isPositiveNumber(value.timeoutMs) || value.timeoutMs > MAX_SUBAGENT_TIMEOUT_MS)
		) {
			return undefined;
		}
		config.timeoutMs = value.timeoutMs;
		hasKnownField = true;
	}

	return hasKnownField ? config : undefined;
}

export function normalizeSubagentSettings(value: unknown): SubagentSettings | undefined {
	if (!isPlainObject(value)) return undefined;
	const settings: SubagentSettings = {};
	if (hasOwn(value, "agents")) {
		if (!isPlainObject(value.agents)) return undefined;
		const agents: Record<string, SubagentAgentConfig> = {};
		for (const [name, rawConfig] of Object.entries(value.agents)) {
			const config = normalizeAgentSettings(rawConfig);
			if (config) agents[name] = config;
		}
		if (Object.keys(agents).length > 0) settings.agents = agents;
	}
	if (hasOwn(value, "blocking")) {
		if (!isPlainObject(value.blocking)) return undefined;
		const blocking: NonNullable<SubagentSettings["blocking"]> = {};
		if (hasOwn(value.blocking, "enabled")) {
			if (typeof value.blocking.enabled !== "boolean") return undefined;
			blocking.enabled = value.blocking.enabled;
		}
		if (hasOwn(value.blocking, "maxParallelTasks")) {
			if (
				!isPositiveInteger(value.blocking.maxParallelTasks) ||
				value.blocking.maxParallelTasks > MAX_CONFIGURABLE_PARALLEL_TASKS
			) {
				return undefined;
			}
			blocking.maxParallelTasks = value.blocking.maxParallelTasks;
		}
		settings.blocking = blocking;
	}
	if (hasOwn(value, "stateful")) {
		if (!isPlainObject(value.stateful)) return undefined;
		const runtime: NonNullable<SubagentSettings["stateful"]> = {};
		if (hasOwn(value.stateful, "transport")) {
			if (value.stateful.transport !== "subprocess" && value.stateful.transport !== "in-process") {
				return undefined;
			}
			runtime.transport = value.stateful.transport;
		}
		if (hasOwn(value.stateful, "completionDelivery")) {
			if (
				value.stateful.completionDelivery !== "next-turn" &&
				value.stateful.completionDelivery !== "auto-resume"
			) {
				return undefined;
			}
			runtime.completionDelivery = value.stateful.completionDelivery;
		}
		for (const key of STATEFUL_LIMIT_FIELDS) {
			if (hasOwn(value.stateful, key)) {
				if (!isValidStatefulLimit(key, value.stateful[key])) return undefined;
				runtime[key] = value.stateful[key];
			}
		}
		for (const key of ["maxMailboxMessages", "maxMailboxMessageBytes", "idleTtlMs"] as const) {
			if (hasOwn(value.stateful, key)) {
				if (!isPositiveInteger(value.stateful[key])) return undefined;
				runtime[key] = value.stateful[key];
			}
		}
		if (hasOwn(value.stateful, "retentionDays")) {
			if (!isPositiveNumber(value.stateful.retentionDays)) return undefined;
			runtime.retentionDays = value.stateful.retentionDays;
		}
		if (hasOwn(value.stateful, "enabled")) {
			if (typeof value.stateful.enabled !== "boolean") return undefined;
			runtime.enabled = value.stateful.enabled;
		}
		if (hasOwn(value.stateful, "fleetView")) {
			if (value.stateful.fleetView !== "off" && value.stateful.fleetView !== "active") {
				return undefined;
			}
			runtime.fleetView = value.stateful.fleetView;
		}
		if (hasOwn(value.stateful, "lifecycleArtifacts")) {
			if (
				value.stateful.lifecycleArtifacts !== "off" &&
				value.stateful.lifecycleArtifacts !== "metadata"
			) {
				return undefined;
			}
			runtime.lifecycleArtifacts = value.stateful.lifecycleArtifacts;
		}
		settings.stateful = runtime;
	}
	if (hasOwn(value, "consult")) {
		if (!isPlainObject(value.consult)) return undefined;
		const consult: NonNullable<SubagentSettings["consult"]> = {};
		if (hasOwn(value.consult, "resources")) {
			if (
				typeof value.consult.resources !== "string" ||
				!CONSULT_RESOURCE_POLICIES.includes(value.consult.resources as ConsultResourcePolicy)
			) {
				return undefined;
			}
			consult.resources = value.consult.resources as ConsultResourcePolicy;
		}
		settings.consult = consult;
	}
	if (hasOwn(value, "cwdPolicy")) {
		if (!isPlainObject(value.cwdPolicy)) return undefined;
		const cwdPolicy: NonNullable<SubagentSettings["cwdPolicy"]> = {};
		if (hasOwn(value.cwdPolicy, "consultation")) {
			if (
				typeof value.cwdPolicy.consultation !== "string" ||
				!CONSULTATION_CWD_POLICIES.includes(value.cwdPolicy.consultation as ConsultationCwdPolicy)
			) {
				return undefined;
			}
			cwdPolicy.consultation = value.cwdPolicy.consultation as ConsultationCwdPolicy;
		}
		if (hasOwn(value.cwdPolicy, "delegation")) {
			if (
				typeof value.cwdPolicy.delegation !== "string" ||
				!DELEGATION_CWD_POLICIES.includes(value.cwdPolicy.delegation as DelegationCwdPolicy)
			) {
				return undefined;
			}
			cwdPolicy.delegation = value.cwdPolicy.delegation as DelegationCwdPolicy;
		}
		settings.cwdPolicy = cwdPolicy;
	}
	return settings;
}

const SETTINGS_FILE = "pi-subagents.json";
const LEGACY_SETTINGS_FILE = "pi-subagents-config.json";
const DEFAULT_COMPLETION_DELIVERY: CompletionDelivery = "next-turn";
export const DEFAULT_CONSULT_RESOURCE_POLICY: ConsultResourcePolicy = "project-context";
export const DEFAULT_CONSULTATION_CWD_POLICY: ConsultationCwdPolicy = "anywhere";
export const DEFAULT_DELEGATION_CWD_POLICY: DelegationCwdPolicy = "trusted-targets";
const SETTINGS_LOCK_FS_ADAPTER = {
	mkdir: fs.mkdir,
	mkdirSync: fs.mkdirSync,
	realpath: fs.realpath,
	realpathSync: fs.realpathSync,
	rmdir: fs.rmdir,
	rmdirSync: fs.rmdirSync,
	stat: fs.stat,
	statSync: fs.statSync,
	utimes: fs.utimes,
	utimesSync: fs.utimesSync,
};
let pendingSettingsNotice: string | undefined;

function resolveSubagentSettingsPaths(): {
	canonicalPath: string;
	legacyPath: string;
	activePath?: string;
} {
	const canonicalPath = path.join(getAgentDir(), SETTINGS_FILE);
	const legacyPath = path.join(getAgentDir(), LEGACY_SETTINGS_FILE);
	return {
		canonicalPath,
		legacyPath,
		activePath: fs.existsSync(canonicalPath)
			? canonicalPath
			: fs.existsSync(legacyPath)
				? legacyPath
				: undefined,
	};
}

export function readSubagentSettings(): SubagentSettings | undefined {
	pendingSettingsNotice = undefined;
	const { canonicalPath, legacyPath, activePath } = resolveSubagentSettingsPaths();
	if (activePath === canonicalPath) {
		const canonical = readSettingsFile(canonicalPath);
		const notices: string[] = [];
		if (!canonical) notices.push(`${SETTINGS_FILE} is invalid and was ignored.`);
		if (fs.existsSync(legacyPath)) {
			notices.push(`${LEGACY_SETTINGS_FILE} ignored because ${SETTINGS_FILE} takes precedence.`);
		}
		if (notices.length > 0) pendingSettingsNotice = notices.join("\n");
		return canonical;
	}
	if (activePath === undefined) return undefined;
	const legacy = readSettingsFile(legacyPath);
	if (fs.existsSync(canonicalPath)) {
		const canonical = readSettingsFile(canonicalPath);
		pendingSettingsNotice = [
			...(!canonical ? [`${SETTINGS_FILE} is invalid and was ignored.`] : []),
			`${LEGACY_SETTINGS_FILE} ignored because ${SETTINGS_FILE} was created concurrently.`,
		].join("\n");
		return canonical;
	}
	if (!legacy) {
		pendingSettingsNotice = `${LEGACY_SETTINGS_FILE} is invalid and was ignored.`;
		return undefined;
	}
	pendingSettingsNotice = `Using legacy ${LEGACY_SETTINGS_FILE}; rename it to ${SETTINGS_FILE}. Future saves write ${SETTINGS_FILE} without modifying the legacy file.`;
	return legacy;
}

export function consumeSubagentSettingsNotice() {
	const notice = pendingSettingsNotice;
	pendingSettingsNotice = undefined;
	return notice;
}

export function saveSubagentConfig(settings: SubagentSettings): void {
	writeSettingsObject(settings);
}

export type DelegationWorkflow = "all" | "async-only" | "blocking-only" | "disabled";

export interface DelegationWorkflowSettingsSnapshot {
	path: string;
	value: DelegationWorkflow;
	source: "default" | "user settings";
	error?: string;
}

export interface CompletionDeliverySettingsSnapshot {
	path: string;
	value: CompletionDelivery;
	source: "default" | "user settings";
	error?: string;
}

export interface StatefulFeatureSettingsSnapshot<T> {
	path: string;
	value: T;
	source: "default" | "user settings";
	error?: string;
}

export interface BlockingParallelLimitSettingsSnapshot {
	path: string;
	value: number;
	source: "default" | "user settings";
	error?: string;
}

export interface StatefulLimitFieldSnapshot {
	value: number;
	source: "default" | "user settings";
}

export interface StatefulLimitSettingsSnapshot {
	path: string;
	writePath: string;
	values?: Record<StatefulLimitField, StatefulLimitFieldSnapshot>;
	error?: string;
}

export interface ConsultResourceSettingsSnapshot {
	path: string;
	value: ConsultResourcePolicy;
	source: "default" | "user settings";
	error?: string;
}

export interface CwdPolicyFieldSnapshot<T> {
	value: T;
	source: "default" | "user settings";
}

export interface CwdPolicySettingsSnapshot {
	path: string;
	consultation: CwdPolicyFieldSnapshot<ConsultationCwdPolicy>;
	delegation: CwdPolicyFieldSnapshot<DelegationCwdPolicy>;
	error?: string;
}

export interface SubagentSettingsSnapshot {
	path: string;
	settings?: SubagentSettings;
	source: "default" | "user settings";
	error?: string;
}

export function subagentSettingsFilePath(): string {
	return path.join(getAgentDir(), SETTINGS_FILE);
}

export function resolveDelegationWorkflow(
	blockingEnabled: boolean,
	statefulEnabled: boolean,
): DelegationWorkflow {
	if (blockingEnabled && statefulEnabled) return "all";
	if (statefulEnabled) return "async-only";
	if (blockingEnabled) return "blocking-only";
	return "disabled";
}

function inspectSubagentSettingsDocument(): {
	path: string;
	raw?: Record<string, unknown>;
	settings?: SubagentSettings;
	error?: string;
} {
	const { canonicalPath, activePath } = resolveSubagentSettingsPaths();
	if (activePath === undefined) return { path: canonicalPath };
	const inspected = inspectSubagentSettingsPath(activePath);
	return activePath !== canonicalPath && fs.existsSync(canonicalPath)
		? inspectSubagentSettingsPath(canonicalPath)
		: inspected;
}

function inspectSubagentSettingsPath(configPath: string): {
	path: string;
	raw?: Record<string, unknown>;
	settings?: SubagentSettings;
	error?: string;
} {
	const fileName = path.basename(configPath);
	let contents: string;
	try {
		contents = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			path: configPath,
			error: `${fileName} could not be read${code ? ` (${safeErrorCode(code)})` : ""}`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(contents);
	} catch {
		return { path: configPath, error: `${fileName} contains malformed JSON` };
	}
	const settings = normalizeSubagentSettings(raw);
	if (!isPlainObject(raw) || !settings) {
		return { path: configPath, error: `${fileName} is not a valid settings object` };
	}
	return { path: configPath, raw, settings };
}

export function inspectSubagentSettings(): SubagentSettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	return {
		path: inspected.path,
		settings: inspected.settings,
		source: inspected.settings ? "user settings" : "default",
		...(inspected.error ? { error: inspected.error } : {}),
	};
}

export function inspectConsultResourceSettings(): ConsultResourceSettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: DEFAULT_CONSULT_RESOURCE_POLICY,
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		isPlainObject(inspected.raw.consult) && hasOwn(inspected.raw.consult, "resources");
	return {
		path: inspected.path,
		value: inspected.settings.consult?.resources ?? DEFAULT_CONSULT_RESOURCE_POLICY,
		source: explicit ? "user settings" : "default",
	};
}

export function inspectCwdPolicySettings(): CwdPolicySettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			consultation: { value: DEFAULT_CONSULTATION_CWD_POLICY, source: "default" },
			delegation: { value: DEFAULT_DELEGATION_CWD_POLICY, source: "default" },
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const rawPolicy = isPlainObject(inspected.raw.cwdPolicy) ? inspected.raw.cwdPolicy : undefined;
	return {
		path: inspected.path,
		consultation: {
			value: inspected.settings.cwdPolicy?.consultation ?? DEFAULT_CONSULTATION_CWD_POLICY,
			source: rawPolicy && hasOwn(rawPolicy, "consultation") ? "user settings" : "default",
		},
		delegation: {
			value: inspected.settings.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY,
			source: rawPolicy && hasOwn(rawPolicy, "delegation") ? "user settings" : "default",
		},
	};
}

export function inspectDelegationWorkflowSettings(): DelegationWorkflowSettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: "all",
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		(isPlainObject(inspected.raw.blocking) && hasOwn(inspected.raw.blocking, "enabled")) ||
		(isPlainObject(inspected.raw.stateful) && hasOwn(inspected.raw.stateful, "enabled"));
	return {
		path: inspected.path,
		value: resolveDelegationWorkflow(
			inspected.settings.blocking?.enabled !== false,
			inspected.settings.stateful?.enabled !== false,
		),
		source: explicit ? "user settings" : "default",
	};
}

export function inspectCompletionDeliverySettings(): CompletionDeliverySettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: DEFAULT_COMPLETION_DELIVERY,
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		isPlainObject(inspected.raw.stateful) && hasOwn(inspected.raw.stateful, "completionDelivery");
	return {
		path: inspected.path,
		value: inspected.settings.stateful?.completionDelivery ?? DEFAULT_COMPLETION_DELIVERY,
		source: explicit ? "user settings" : "default",
	};
}

export function inspectFleetViewSettings(): StatefulFeatureSettingsSnapshot<FleetViewMode> {
	return inspectStatefulFeature("fleetView", "off");
}

export function inspectLifecycleArtifactSettings(): StatefulFeatureSettingsSnapshot<LifecycleArtifactsMode> {
	return inspectStatefulFeature("lifecycleArtifacts", "off");
}

function inspectStatefulFeature<T extends FleetViewMode | LifecycleArtifactsMode>(
	field: "fleetView" | "lifecycleArtifacts",
	defaultValue: T,
): StatefulFeatureSettingsSnapshot<T> {
	const inspected = inspectSubagentSettingsDocument();
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: defaultValue,
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const rawStateful = isPlainObject(inspected.raw.stateful) ? inspected.raw.stateful : undefined;
	const value = inspected.settings.stateful?.[field] ?? defaultValue;
	return {
		path: inspected.path,
		value: value as T,
		source: rawStateful && hasOwn(rawStateful, field) ? "user settings" : "default",
	};
}

export function resolveBlockingMaxParallelTasks(settings?: SubagentSettings): number {
	return settings?.blocking?.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
}

export function inspectBlockingParallelLimitSettings(): BlockingParallelLimitSettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: DEFAULT_MAX_PARALLEL_TASKS,
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		isPlainObject(inspected.raw.blocking) && hasOwn(inspected.raw.blocking, "maxParallelTasks");
	return {
		path: inspected.path,
		value: resolveBlockingMaxParallelTasks(inspected.settings),
		source: explicit ? "user settings" : "default",
	};
}

export function inspectStatefulLimitSettings(): StatefulLimitSettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	const writePath = subagentSettingsFilePath();
	if (inspected.error) {
		return { path: inspected.path, writePath, error: inspected.error };
	}
	const resolved = resolveStatefulLimits(inspected.settings?.stateful);
	const rawStateful = isPlainObject(inspected.raw?.stateful) ? inspected.raw.stateful : undefined;
	return {
		path: inspected.path,
		writePath,
		values: Object.fromEntries(
			STATEFUL_LIMIT_FIELDS.map((field) => [
				field,
				{
					value: resolved[field],
					source: rawStateful && hasOwn(rawStateful, field) ? "user settings" : "default",
				},
			]),
		) as unknown as Record<StatefulLimitField, StatefulLimitFieldSnapshot>,
	};
}

export function updateDelegationWorkflowSetting(
	value: Exclude<DelegationWorkflow, "disabled">,
): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const blocking = raw.blocking;
		if (blocking !== undefined && !isPlainObject(blocking)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} blocking settings`);
		}
		const stateful = raw.stateful;
		if (stateful !== undefined && !isPlainObject(stateful)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				blocking: {
					...(blocking ?? {}),
					enabled: value !== "async-only",
				},
				stateful: {
					...(stateful ?? {}),
					enabled: value !== "blocking-only",
				},
			},
			update.replaceCanonical,
		);
	});
}

export function updateCompletionDeliverySetting(value: CompletionDelivery): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const stateful = raw.stateful;
		if (stateful !== undefined && !isPlainObject(stateful)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				stateful: {
					...(stateful ?? {}),
					completionDelivery: value,
				},
			},
			update.replaceCanonical,
		);
	});
}

export function updateFleetViewSetting(value: FleetViewMode): void {
	if (value !== "off" && value !== "active") throw new Error("Invalid FleetView setting");
	updateStatefulFeatureSetting("fleetView", value);
}

export function updateLifecycleArtifactSetting(value: LifecycleArtifactsMode): void {
	if (value !== "off" && value !== "metadata") {
		throw new Error("Invalid lifecycle artifact setting");
	}
	updateStatefulFeatureSetting("lifecycleArtifacts", value);
}

function updateStatefulFeatureSetting(
	field: "fleetView" | "lifecycleArtifacts",
	value: FleetViewMode | LifecycleArtifactsMode,
): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const stateful = raw.stateful;
		if (stateful !== undefined && !isPlainObject(stateful)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
		}
		writeSettingsObjectUnlocked(
			{ ...raw, stateful: { ...(stateful ?? {}), [field]: value } },
			update.replaceCanonical,
		);
	});
}

export function updateBlockingMaxParallelTasksSetting(value: number): void {
	if (!isPositiveInteger(value) || value > MAX_CONFIGURABLE_PARALLEL_TASKS) {
		throw new Error(
			`Maximum parallel tasks must be an integer between 1 and ${MAX_CONFIGURABLE_PARALLEL_TASKS}`,
		);
	}
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const blocking = raw.blocking;
		if (blocking !== undefined && !isPlainObject(blocking)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} blocking settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				blocking: {
					...(blocking ?? {}),
					maxParallelTasks: value,
				},
			},
			update.replaceCanonical,
		);
	});
}

export function updateStatefulLimitSetting(
	field: StatefulLimitField,
	value: number,
	expected?: StatefulLimits,
): void {
	if (!isValidStatefulLimit(field, value)) {
		throw new Error(
			`${field} must be a safe integer greater than or equal to ${statefulLimitDefinition(field).minimum}`,
		);
	}
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const stateful = raw.stateful;
		if (stateful !== undefined && !isPlainObject(stateful)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
		}
		const normalized = normalizeSubagentSettings(raw);
		if (!normalized) throw new Error(`Cannot update invalid ${SETTINGS_FILE}`);
		if (expected && !sameStatefulLimits(resolveStatefulLimits(normalized.stateful), expected)) {
			throw new Error("Detached limit settings changed; reopen settings and retry");
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				stateful: { ...(stateful ?? {}), [field]: value },
			},
			update.replaceCanonical,
		);
	});
}

export function updateConsultResourceSetting(value: ConsultResourcePolicy): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const consult = raw.consult;
		if (consult !== undefined && !isPlainObject(consult)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} consult settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				consult: {
					...(consult ?? {}),
					resources: value,
				},
			},
			update.replaceCanonical,
		);
	});
}

export function updateCwdPolicySetting(field: "consultation", value: ConsultationCwdPolicy): void;
export function updateCwdPolicySetting(field: "delegation", value: DelegationCwdPolicy): void;
export function updateCwdPolicySetting(
	field: "consultation" | "delegation",
	value: ConsultationCwdPolicy | DelegationCwdPolicy,
): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const cwdPolicy = raw.cwdPolicy;
		if (cwdPolicy !== undefined && !isPlainObject(cwdPolicy)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} cwdPolicy settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				cwdPolicy: { ...(cwdPolicy ?? {}), [field]: value },
			},
			update.replaceCanonical,
		);
	});
}

export function updateAgentToolsSetting(name: string, tools: string[] | undefined): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const rawAgents = raw.agents;
		if (rawAgents !== undefined && !isPlainObject(rawAgents)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} agent settings`);
		}
		const agents = { ...(rawAgents ?? {}) };
		const rawAgent = hasOwn(agents, name) ? agents[name] : undefined;
		if (rawAgent !== undefined && !isPlainObject(rawAgent)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} settings for ${name}`);
		}
		const agent = { ...(rawAgent ?? {}) };
		if (tools === undefined) delete agent.tools;
		else agent.tools = tools;
		if (Object.keys(agent).length > 0) {
			Object.defineProperty(agents, name, {
				value: agent,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		} else {
			delete agents[name];
		}

		const updated = { ...raw };
		if (Object.keys(agents).length > 0) updated.agents = agents;
		else delete updated.agents;
		writeSettingsObjectUnlocked(updated, update.replaceCanonical);
	});
}

interface SettingsObjectForUpdate {
	document: Record<string, unknown>;
	replaceCanonical: boolean;
}

function readSettingsObjectForUpdate(): SettingsObjectForUpdate {
	const { canonicalPath, activePath } = resolveSubagentSettingsPaths();
	if (activePath === undefined) return { document: {}, replaceCanonical: false };
	const activeFile = path.basename(activePath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(activePath, "utf8"));
	} catch {
		throw new Error(`Cannot update malformed ${activeFile}`);
	}
	if (!isPlainObject(parsed) || !normalizeSubagentSettings(parsed)) {
		throw new Error(`Cannot update invalid ${activeFile}`);
	}
	return { document: parsed, replaceCanonical: activePath === canonicalPath };
}

function writeSettingsObject(settings: object, replaceCanonical?: boolean): void {
	withSettingsMutationLock(() => writeSettingsObjectUnlocked(settings, replaceCanonical));
}

function writeSettingsObjectUnlocked(settings: object, replaceCanonical?: boolean): void {
	const agentDir = getAgentDir();
	fs.mkdirSync(agentDir, { recursive: true });
	const configPath = path.join(agentDir, SETTINGS_FILE);
	const tempFile = path.join(agentDir, `.${SETTINGS_FILE}.${randomUUID()}.tmp`);
	// Updates seeded from a missing or legacy document must remain exclusive even if the
	// canonical path appears after the read and before publication.
	const firstCanonicalPublication = !(replaceCanonical ?? pathEntryExists(configPath));
	try {
		fs.writeFileSync(tempFile, `${JSON.stringify(settings, null, "\t")}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		if (firstCanonicalPublication && pathEntryExists(configPath)) {
			throw new Error(`${SETTINGS_FILE} was created concurrently; reopen settings and retry`);
		}
		fs.renameSync(tempFile, configPath);
	} finally {
		try {
			fs.rmSync(tempFile, { force: true });
		} catch {
			// Preserve the save result if best-effort temp cleanup fails.
		}
	}
}

function withSettingsMutationLock<T>(mutate: () => T): T {
	const agentDir = getAgentDir();
	fs.mkdirSync(agentDir, { recursive: true });
	const configPath = path.join(agentDir, SETTINGS_FILE);
	const release = lockfile.lockSync(configPath, {
		fs: SETTINGS_LOCK_FS_ADAPTER,
		lockfilePath: `${configPath}.mutation-lock`,
		realpath: false,
	});
	try {
		return mutate();
	} finally {
		release();
	}
}

function sameStatefulLimits(left: StatefulLimits, right: StatefulLimits): boolean {
	return STATEFUL_LIMIT_FIELDS.every((field) => left[field] === right[field]);
}

function pathEntryExists(filePath: string): boolean {
	try {
		fs.lstatSync(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function readSettingsFile(configPath: string): SubagentSettings | undefined {
	return readSettingsSnapshot(configPath).settings;
}

function readSettingsSnapshot(configPath: string): {
	settings?: SubagentSettings;
	contents?: string;
} {
	try {
		const contents = fs.readFileSync(configPath, "utf8");
		return { settings: normalizeSubagentSettings(JSON.parse(contents)), contents };
	} catch {
		return {};
	}
}

function safeErrorCode(value: string): string {
	return value.replace(/[^A-Z0-9_-]/giu, "?").slice(0, 64);
}

export function uniqueToolNames(tools: string[]): string[] {
	return [...new Set(tools)];
}

export function sameToolSet(left: string[], right: string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) return false;
	return [...leftSet].every((tool) => rightSet.has(tool));
}

export function resolveSubagentThinkingLevel(
	agents: readonly Pick<AgentConfig, "name" | "thinkingLevel">[],
	agentName: string,
	topLevelThinkingLevel?: SubagentThinkingLevel,
	localThinkingLevel?: SubagentThinkingLevel,
): SubagentThinkingLevel | undefined {
	return (
		localThinkingLevel ??
		topLevelThinkingLevel ??
		agents.find((agent) => agent.name === agentName)?.thinkingLevel
	);
}

export function hasAnyAgentOverride(config: SubagentAgentConfig): boolean {
	return (
		hasOwn(config, "tools") ||
		hasOwn(config, "model") ||
		hasOwn(config, "thinkingLevel") ||
		hasOwn(config, "timeoutMs")
	);
}
