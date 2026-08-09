import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { ManagedAgent } from "./registry.js";
import { safeTerminalLine } from "./safe-text.js";

export const FLEET_WIDGET_KEY = "subagents:fleet";
const MAX_FLEET_ROWS = 5;

export function updateFleetWidget(
	ctx: Pick<ExtensionContext, "mode" | "ui">,
	enabled: boolean,
	agents: readonly ManagedAgent[],
): void {
	if (ctx.mode !== "tui" || !enabled) {
		ctx.ui.setWidget(FLEET_WIDGET_KEY, undefined);
		return;
	}
	const active = agents.filter((agent) => agent.state === "starting" || agent.state === "running");
	if (active.length === 0) {
		ctx.ui.setWidget(FLEET_WIDGET_KEY, undefined);
		return;
	}
	const snapshot = active.slice(0, MAX_FLEET_ROWS).map((agent) => ({ ...agent }));
	const omitted = Math.max(0, active.length - snapshot.length);
	ctx.ui.setWidget(
		FLEET_WIDGET_KEY,
		(_tui, theme) => ({
			render(width: number): string[] {
				const safeWidth = Math.max(1, width);
				const lines = [
					truncateToWidth(theme.bold(theme.fg("accent", "Subagents")), safeWidth, "…"),
				];
				for (const agent of snapshot) {
					const state = agent.state === "starting" ? "STARTING" : "RUNNING";
					const task = safeLine(agent.currentTask ?? "(no task)");
					const raw = `${state} ${safeLine(agent.agent)} ${safeLine(agent.id)} — ${task}`;
					lines.push(truncateToWidth(raw, safeWidth, "…"));
				}
				if (omitted > 0) lines.push(truncateToWidth(`… ${omitted} more active`, safeWidth, "…"));
				lines.push(truncateToWidth("Manage with /subagents", safeWidth, "…"));
				return lines;
			},
			invalidate() {},
		}),
		{ placement: "belowEditor" },
	);
}

function safeLine(value: string): string {
	return safeTerminalLine(stripTerminalSequences(value));
}
