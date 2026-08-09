# 🧑‍🤝‍🧑 pi-subagents — Isolated Subagents for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-subagents` is a native [Pi coding agent](https://pi.dev) extension for delegating work to specialized agents. By default, it exposes seven capability-specific tools: blocking batches, four detached lifecycle tools, side-effect-free inspection, and synchronous read-only consultation. Users can keep every delegation method, choose async-only delegation, retain only blocking delegation, or disable delegation while keeping inspection available.

Use it to split independent research, planning, implementation, and review work across focused workers. Under the default next-turn delivery policy, background delegation is for work the current response does not depend on. Opt-in auto-resume also supports final-answer-dependent background work by requesting a synthesis turn after completion.

## ✨ Features

- Offers all delegation methods by default, with goal-oriented presets for async-only, blocking-only, or disabled delegation.
- Adds `subagent_inspect` for bounded metadata without child launch, mailbox-content access, acknowledgement, or mutation.
- Adds `subagent_consult` for one synchronous ephemeral child constrained to built-in `read`, `grep`, `find`, and `ls` tools (or a narrower agent allow-list).
- Keeps batch workers isolated in `pi --mode json -p --no-session` subprocesses.
- Lets users set a blocking parallel call's maximum worker count from 1 through 64 while keeping four-at-a-time execution.
- Registers detached stateful lifecycle tools by default; completion can stay queued for the next turn or opt into an idle root synthesis turn.
- Supports an opt-in public-SDK `in-process` stateful transport with one reusable child `AgentSession` per `agentId`.
- Supports built-in `scout`, `planner`, `reviewer`, and `worker` agents.
- Loads custom user agents from `~/.pi/agent/agents/*.md`.
- Optionally loads project agents from `.pi/agents/*.md` with confirmation.
- Provides a current-session-first `/subagents` manager with per-agent follow-up, mailbox, interrupt, close, and subtree actions.
- Offers an opt-in read-only active-agent FleetView below the editor without capturing terminal input.
- Exposes an optional versioned `pi-subagents:v1` event API for preflight, one-leaf foreground delegation, cancellation, and session-scoped capability ceilings.
- Supports trust-aware per-task `cwd` policies, hard subprocess `timeoutMs`, task-selected `thinkingLevel`, abort propagation, and streaming progress.
- Renders all seven tools with Pi-native compact/expanded transcript rows; long-running blocking and consultation calls show bounded live activity.
- Bounds JSON lines, captured messages, stderr, final output, chain substitution, and fan-in context.
- Enforces a recursion-depth guard and deterministic process-group termination.
- Provides addressable stateful agents with follow-up, consolidated mailbox/management actions, context selection, and persistence.
- Publishes transient runtime status through Pi's generic extension status API while subagents are running.
- Returns complete bounded worker output in tool details and a concise result for the main agent.

## 📦 Install

```bash
pi install npm:@narumitw/pi-subagents
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-subagents
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-subagents
```

## 🛠️ Pi tool

`pi-subagents` registers seven tools by default. Run `/subagents`, choose **Change delegation**, review the concrete tool changes, then select **Save and reload** to apply one of these workflows:

| Workflow | Registered tools |
| --- | --- |
| **All delegation methods** (default) | Existing five delegation/lifecycle tools, `subagent_inspect`, and `subagent_consult` |
| **Async only** | Four detached lifecycle tools plus `subagent_inspect`; blocking `subagent` and `subagent_consult` are omitted |
| **Blocking only** | `subagent`, `subagent_consult`, and `subagent_inspect` |
| **Disabled** | `subagent_inspect` only; delegation is disabled |

The preview compares the selection with the tools registered in the current session, even when a manual settings edit is pending, and remains read-only until confirmation. Escape or **Cancel** leaves settings unchanged. Tool removal requires an extension reload because Pi does not expose extension tool unregistration. To avoid aborting work or removing isolated worktrees during `session_shutdown`, workflow changes are blocked while detached agents are retained; finish or clear them through **Current agents** first. Pi owns reload-error reporting and does not return a success result to extensions, so the save notification also tells users to run `/reload` if the tool surface does not refresh.

The available tools are:

- `subagent` — delegate blocking single, parallel, fan-in, or chained batch work. The main agent cannot process queued steering until the call returns.
- `subagent_spawn` and related lifecycle tools — when enabled, start reusable detached work, return immediately, and receive bounded completion messages automatically.
- `subagent_inspect` — inspect agent/model/run/runtime metadata without launching work or changing state.
- `subagent_consult` — run one ephemeral read-only consultation and wait for its answer.

### Interactive tool rows

In Pi's interactive TUI, every registered tool uses Pi's native tool shell and theme. Call rows identify the action, agent or retained id, scope, and a bounded task/message preview. Result rows use explicit `Starting`, `Running`, `Completed`, `Failed`, `Cancelled`, `Interrupted`, or `Closed` text in addition to icons and color.

Collapsed rows stay scan-friendly: consultation and blocking calls show recent activity while running, completed answers show up to three lines, and list actions show up to five items. Use Pi's configured `app.tools.expand` keybinding (Ctrl+O by default) for the additional bounded task, policy, activity, answer, usage, inspection, or mailbox details available to that tool. The hint follows the user's keybinding rather than assuming Ctrl+O.

`subagent_consult` emits an initial starting update before launching its child and then reports the actual provider/model, thinking request, usage, and a safe projection of recent `read`, `grep`, `find`, and `ls` activity. Progress never includes full child messages, prompts, credentials, headers, or environment values. Tool-row previews remove terminal controls and redact private text.

`subagent_spawn` remains deliberately detached and non-polling: its tool row ends after returning the new `agentId` and initial retained state. It does not pretend to stream the background child after the tool call has completed; the existing completion message and configured delivery policy report eventual completion.

Custom transcript rendering is TUI presentation only. Tool names, parameter schemas, model-facing final content/details, errors, completion delivery, and print/JSON/RPC final output remain unchanged; JSON/RPC observers may see additive bounded consultation partial-progress details.

After each session starts, the descriptions of the registered `subagent`, `subagent_spawn`, and
`subagent_consult` tools include the same bounded parent-facing catalog of the agents available in
that session. Entries show the source (`built-in`, `user`, or `project`) and the `agentScope` needed to
invoke them; the `agent` parameters remain unconstrained strings for cwd and scope flexibility. The
catalog is rebuilt on
`/reload` or the next session start, and omitted entries are reported explicitly when the catalog
exceeds its metadata bounds.

Choose the API by lifecycle:

| Need | Use |
| --- | --- |
| A delegated result is required before the root's next action under default next-turn delivery | Use one blocking `subagent` call when registered. In **Async only**, complete the critical-path work directly or switch workflows before delegating it |
| Broad research/review the current response does not depend on | Prefer one `subagent_spawn` covering related branches, when lifecycle tools are enabled |
| Final-answer-dependent broad work with `completionDelivery: "auto-resume"` | Prefer one `subagent_spawn`; completion requests a synthesis turn |
| Reusable history, follow-ups, or mailboxes | `subagent_spawn` and lifecycle tools, when enabled |
| Side-effect-free agent/model/run diagnostics | `subagent_inspect` |
| Synchronous reconnaissance, planning, or review that must not write | `subagent_consult`, when blocking delegation is enabled |
| One simple or critical-path action the root can perform directly | No subagent |

Execution modes:

- **single** — run one `{ agent, task }` job.
- **parallel** — run multiple `{ agent, task }` jobs independently.
- **parallel + aggregator** — run parallel jobs, then pass all outputs into one fan-in agent.
- **chain** — run sequential steps, passing prior output with `{previous}`.

Common controls:

- `cwd` — choose a launch directory subject to the user-owned trust-aware target policy described below.
- `timeoutMs` — set a hard subprocess timeout.
- `thinkingLevel` — request `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` thinking for the spawned Pi process or in-process child.

For `subagent_spawn`, the root agent selects the lowest thinking level sufficient for the delegated task. This is a tool-argument decision made from the task already in context; `pi-subagents` does not run a string heuristic or an extra classifier model call.

## 🔐 Working-directory trust policy

Pi records saved project trust in `~/.pi/agent/trust.json`. The closest saved decision for the canonical target or one of its parents wins, so trusting a worktree parent covers worktrees below it while a nearer `false` overrides a trusted parent. `pi-subagents` reads this through Pi's public `ProjectTrustStore`; it never parses, writes, or migrates the file. Open Pi in a folder and use `/trust` to manage trust, then restart Pi before expecting retained-runtime behavior to change.

The default target policies are:

| Setting | Values | Default behavior |
| --- | --- | --- |
| `cwdPolicy.consultation` | `"anywhere"`, `"current-workspace"` | `"anywhere"`: consultation may start in any existing directory, but a target without effective trust is forced to `resources: "none"` |
| `cwdPolicy.delegation` | `"trusted-targets"`, `"current-workspace"`, `"anywhere"` | `"trusted-targets"`: blocking and detached delegation may target the current workspace or an external folder covered by a saved `true` decision |

All paths are resolved relative to the current session workspace and canonicalized before containment and trust checks. Missing paths, non-directories, sibling paths, and symlink escapes cannot bypass the policy. Blocking parallel, chain, and fan-in calls preflight every target before any child starts. A generated `workspaceMode: "worktree"` inherits the resolved trust of its approved base cwd.

`"anywhere"` for general delegation restores the previous external-target flexibility. An external target without effective trust starts with `projectTrusted: false`, so Pi-protected project settings, packages, extensions, skills, prompts, and system resources stay disabled. General agents still have their configured tools and ordinary Pi/OS permissions, and Pi may still load `AGENTS.md` or `CLAUDE.md` because those context files are not protected by project trust. Resource-free consultation is stricter: it also passes `--no-context-files`, `--no-skills`, `--no-prompt-templates`, `--no-approve`, and `--no-extensions`.

These controls govern child starting directories and automatically loaded resources. They do **not** restrict absolute paths, shell commands, custom tools, network access, extension code, or filesystem access available to the Pi process. For real isolation, run Pi in a container, VM, micro-VM, or OS sandbox with only the required paths and credentials mounted.

## 🧭 Proactive use

When registered, the blocking `subagent` tool advertises only blocking guidance. When stateful lifecycle tools
are registered, `subagent_spawn` adds detached guidance for the active completion-delivery policy.
Changing the policy through `/subagents settings` refreshes that guidance immediately.

The `subagent`, `subagent_spawn`, and `subagent_consult` descriptions advertise the current agent
catalog automatically; no preliminary list call is needed. Built-ins and user agents appear under the
default `agentScope: "user"`. Trusted project agents appear separately and explicitly require
`agentScope: "project"` or `"both"`; project-authored names and descriptions are not read into
metadata for untrusted projects. If a project definition
shares a name with a user or built-in definition, the user version is the default and the project
version is used only for `"project"`/`"both"`. A user override of a built-in also shows the
built-in fallback available with `agentScope: "project"`; `"both"` keeps the user definition. The
catalog is bounded and reports its omission count; metadata discovery also caps files and bytes read
per scope. Refreshed metadata replaces the previous session's catalog rather than accumulating stale
entries.

Count-selection guidance:

- Use **no subagent** for simple answers, quick targeted edits, latency-sensitive one-step work, or
  critical-path work the main agent can perform directly.
- `subagent` is deliberately blocking: while it runs, the main agent cannot answer queued steering.
  Use it when delegated outputs are required before the next root action and waiting is intentional.
- With default `completionDelivery: "next-turn"`, prefer **one detached `subagent_spawn`** for broad
  research or review only when the current response does not depend on its result. When blocking
  `subagent` is registered, use it for required delegated output because an idle root is not awakened.
  In **Async only**, complete required work directly, opt into `auto-resume` when a later synthesis
  turn is appropriate, or switch delegation workflows.
- With `completionDelivery: "auto-resume"`, prefer one detached `subagent_spawn` for broad related
  research or review even when the final answer depends on it; completion requests a later synthesis
  turn. Do not choose blocking parallel fan-out merely to keep delegation in one turn.
- Use detached `subagent_spawn` only when lifecycle tools are enabled and a bounded independent task
  has a concrete isolation or specialization benefit. After spawning, do useful non-overlapping work
  immediately. Do not poll lifecycle tools for progress or duplicate the delegated work.
- Add another detached agent only for truly independent work with safe workspace concurrency.
  If synchronous parallel or fan-in output is genuinely required, keep blocking `subagent` tasks independent, stay within the configured `blocking.maxParallelTasks` limit, and do not parallelize implementation that may edit the same files or shared state.
  The limit defaults to 8, accepts 1 through 64, and bounds total worker tasks in one call rather than the four-at-a-time execution concurrency.
- Do not use project-local agents unless the user explicitly opts into them with
  `agentScope: "project"` or `"both"`; keep confirmation enabled for untrusted repositories.

Examples where the main agent chooses the count:

No subagent for a known-file edit:

```txt
Rename one symbol in src/foo.ts.
```

One detached agent for a broad asynchronous review that the current response does not require, or when auto-resume is enabled (call `subagent_spawn`):

```json
{
  "agent": "reviewer",
  "task": "Review source, tests, and integration risks for the current changes. Do not edit files. Report PASS/FAIL/PARTIAL with evidence."
}
```

A blocking fan-out is reserved for output that must be synthesized before the root continues (call
`subagent`):

```json
{
  "tasks": [
    {
      "agent": "scout",
      "task": "Research auth-related source files. Report paths and open questions. Do not edit files."
    },
    {
      "agent": "scout",
      "task": "Research auth-related tests. Report coverage gaps. Do not edit files."
    }
  ],
  "aggregator": {
    "agent": "reviewer",
    "task": "Merge these findings into a concise implementation-risk summary. Use {previous}."
  }
}
```

## 🔎 Read-only inspection

`subagent_inspect` is registered in every workflow, including disabled delegation. It never starts a child, sends or acknowledges mailbox messages, interrupts or closes a run, changes settings, refreshes providers, resolves credentials, or modifies files.

| Action | Parameters | Result |
| --- | --- | --- |
| `list_agents` | Optional `agentScope` (default `user`) and `limit` (default 32, maximum 100) | Bounded agent metadata and omission counts |
| `get_agent` | Required `agent`; optional `agentScope` | One resolved definition, safe source path, configured tools, and consultation-effective tools; never the system prompt |
| `list_runs` | Optional `includeClosed` and `limit` (default 50, maximum 100) | Metadata-only retained-run summaries and unread counts |
| `get_run` | Required `agentId` | Safe `cwd`, current-task/error summaries, thinking level, policy, history count, and unread count |
| `list_models` | Optional `limit` (default 50, maximum 100) | Session-scoped models, or the already-loaded available snapshot |
| `status` | No additional fields | Effective workflow, runtime counts/transport, detached limit values, completion delivery, consultation resources, and configured/runtime settings with per-field sources |
| `diagnose` | No additional fields | Structured `pass`, `warning`, and `fail` checks; failed checks are report data rather than a tool error |

The schema rejects fields that do not belong to the selected action. Explicit `project` or `both` scope fails before project-agent discovery unless Pi already trusts the project. Run inspection never returns history output, stored context, or mailbox content; unread counts come from a metadata-only snapshot and do not acknowledge messages. Paths beneath the Pi agent directory use `~`, project paths are workspace-relative, model objects are projected through an allow-list, and model-facing text is bounded to 50 KiB or 2,000 lines.

Compatibility: `subagent_manage({ "action": "list" })` remains supported with its existing behavior. Prefer `subagent_inspect` when a whole tool must be safe to activate on a read-only surface.

## 📖 Read-only consultation

`subagent_consult` is registered whenever blocking delegation is enabled. It runs exactly one synchronous, non-retained child with `--no-session`, `--no-extensions`, and only the effective intersection of the agent tools with `read`, `grep`, `find`, and `ls`. A missing tool list receives those four defaults; an explicit `tools: []` receives `--no-tools`; write, shell, lifecycle, custom, and extension tools cannot enter the child allow-list. The executor policy remains authoritative even when the task or agent prompt asks for implementation.

```json
{
  "agent": "reviewer",
  "task": "Inspect the authentication changes and report correctness and security findings with paths.",
  "thinkingLevel": "high"
}
```

The actionless schema requires `agent` and `task` and accepts optional `agentScope`,
`confirmProjectAgents`, `cwd`, `timeoutMs`, and `thinkingLevel`. Any agent resolved from that scope may
be selected; consultation always intersects its configured tools with the enforced read-only
allow-list rather than defining a separate read-only agent category. An unknown name fails before
launch with a bounded name/source list for the requested scope. Project scope is rejected before
discovery when the project is untrusted. A trusted project agent still asks for confirmation by
default; non-interactive calls fail closed unless they explicitly send
`confirmProjectAgents: false`. Declining an interactive confirmation returns a normal cancelled result
without launching or charging a child.

`consult.resources` controls automatically inherited instruction resources:

| Value | Behavior |
| --- | --- |
| `"project-context"` (default) | Keep ordinary user context/system files and trusted project `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md`; disable skills and prompt templates |
| `"none"` | Use only the package consultation base, selected agent prompt, and enforced read-only instruction |
| `"all"` | Keep ordinarily discoverable trusted context/system/append-system files, skills, and prompt templates |

Extensions remain disabled for all three values. Pi core owns system-prompt source precedence: a trusted project prompt wins over the global prompt, with the global prompt used as fallback. A selected Pi prompt source must be a readable regular file; directories, FIFOs, devices, sockets, and unreadable sources fail before child launch. A current target uses the session's effective project trust, including session-only or CLI overrides. An external target uses the nearest saved trust decision. For an untrusted, explicitly denied, unsaved, or trust-error target, consultation remains available when `cwdPolicy.consultation` permits it but automatically downgrades to `resources: "none"`. This also disables context files because Pi does not protect `AGENTS.md` and `CLAUDE.md` with project trust alone. A saved-trusted external target uses the configured resource policy and discovers `SYSTEM.md`, `APPEND_SYSTEM.md`, and ordinary child context from that target rather than the parent workspace.

Both settings are user-owned in `~/.pi/agent/pi-subagents.json`; projects cannot override them. `cwdPolicy.consultation: "current-workspace"` rejects every canonical external target before agent discovery or launch even when that target is saved-trusted. This is not a path sandbox: read-only tools can still read an explicitly requested accessible absolute path.

Result details report the canonical safe cwd, current/external boundary, bounded target-trust decision/source/warning, requested and effective tools/resources, downgrade reason, agent/model/thinking/timeout metadata, and the facts that extensions, session persistence, and retained-agent state are disabled. They never dump prompt contents or the full trust store. Nested model usage is returned through Pi's usage field, so footer, `/session`, and RPC totals include consultation cost. Validation, disallowed targets, and launch failures throw. Failures after model launch preserve bounded partial evidence and usage while the finalized Pi tool result is marked as an error. Abort, timeout, session replacement, and shutdown use the existing process-tree termination and temporary-file cleanup path.

## 🚀 Blocking batch examples

Every example in this section calls `subagent` and keeps the main agent unavailable until the batch
finishes. Use `subagent_spawn` instead when the work can complete asynchronously and its configured
completion policy supports when synthesis is needed.

Run one read-only reconnaissance agent:

```json
{
  "agent": "scout",
  "task": "Find the statusline extension entry points"
}
```

For genuinely random values, specify the range, duplicate policy, and a system randomness source instead of relying on model sampling, for example: `Use Python secrets to return 10 integers from 0 through 999; duplicates are allowed.`

Run multiple agents in parallel with a shared thinking level and one per-task override:

```json
{
  "tasks": [
    {
      "agent": "scout",
      "task": "Map package metadata files",
      "timeoutMs": 30000,
      "thinkingLevel": "low"
    },
    {
      "agent": "reviewer",
      "task": "Review TypeScript config consistency"
    }
  ],
  "timeoutMs": 120000,
  "thinkingLevel": "medium"
}
```

Omit `aggregator` entirely when parallel worker outputs should return directly. Do not send `null`,
empty strings, or an empty object for an unused optional field; for compatibility, an aggregator with
an empty or whitespace-only `agent` or `task` is treated as absent.

Run parallel workers, then aggregate their results:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find auth-related code" },
    { "agent": "scout", "task": "Find auth-related tests" }
  ],
  "aggregator": {
    "agent": "reviewer",
    "task": "Merge, dedupe, and verify these findings. Use {previous}."
  }
}
```

Run a chain where each step receives the previous output:

```json
{
  "chain": [
    { "agent": "scout", "task": "Find subagent-related code" },
    {
      "agent": "planner",
      "task": "Using this context, plan the extension: {previous}"
    }
  ]
}
```

## 🔁 Stateful agents

Stateful lifecycle tools are available by default. `subagent_spawn` is detached: it schedules work, returns immediately with an opaque `agentId`, and later injects a bounded `pi-subagent-completion` custom message. Completions that settle in the same dispatch window are batched, and the broker allows at most one in-flight root wake until that parent turn starts.

Detached work follows a non-polling policy. With default `next-turn` delivery, prefer one bounded `subagent_spawn` for related asynchronous research or review only when the current response does not depend on its result. If it does, use blocking `subagent` when registered; in **Async only**, complete required work directly, opt into `auto-resume` when a later synthesis turn is appropriate, or switch workflows. With opt-in `auto-resume`, detached broad work may be final-answer-dependent because completion requests a synthesis turn after the root settles. In either mode, do useful non-overlapping main-agent work immediately, do not poll `subagent_manage` with `action: "list"` or `subagent_mailbox` with `action: "read"`, and do not duplicate delegated work. Add another detached agent only for truly independent work with safe workspace concurrency. Detached lifecycle work intentionally has no `subagent_wait` tool.

A detached agent additionally needs a concrete isolation or specialization benefit such as independent review, bounded context/output, a distinct model/tool profile, or workspace isolation. Simple work that the main agent can perform directly should not be delegated.

`stateful.completionDelivery` controls settled completion delivery:

- `"next-turn"` (default) preserves the previous behavior: use `deliverAs: "steer"` with `triggerTurn: false`. An active root can consume completion naturally; an idle root is not awakened.
- `"auto-resume"` holds completion while the root is active, then requests one synthesis turn after the parent settles when no user or extension messages are already pending. Simultaneous completions share that turn, active work is not interrupted, and pending input suppresses the autonomous wake.

Auto-resume is best-effort because Pi's custom-message API is fire-and-forget. Session-generation checks, shutdown cleanup, batching, and the in-flight wake guard prevent stale or duplicate scheduling pressure, but they do not make completion delivery durable across process exit.

The default `subprocess` transport preserves compatibility: each turn starts a fresh isolated `pi --mode json -p --no-session` child and receives sanitized, bounded history. Set `transport` to `in-process` to retain one public Pi SDK `AgentSession` per stateful `agentId`, avoiding repeated process startup while preserving native child history in memory.

Run `/subagents` in TUI mode to open the standard primary manager.
It leads with the current delegation workflow, human-readable async completion behavior, consultation/delegation target policies, consultation-resource policy, parallel-worker limit, and active/retained counts.
**Change delegation**, **Current agents**, and **Settings** cover the common workflows.
Agent permissions, **Maximum parallel workers**, **Detached agent limits**, transport/runtime details, source, and settings path remain under **Advanced settings**.
The parallel-worker input rejects invalid values without discarding the draft and applies a successful save immediately.
The detached-limit screen edits retained capacity, active-turn concurrency, direct children, tree depth, and stored-record capacity.
Detached-limit saves are durable immediately but apply to the runtime after `/reload` or the next Pi session.
Escape returns from a nested screen to a newly refreshed manager, while Ctrl+C closes the full flow.
Exact workflow/reload and project-agent safety confirmations remain extension-owned because they guard live agent and trust-boundary policy rather than ordinary navigation.

The direct routes remain predictable: `/subagents settings` changes target policies, consultation resources, completion delivery, FleetView, and lifecycle-artifact publication; launch and FleetView changes apply immediately, while lifecycle artifacts apply after reload; `/subagents status` reports current-session runtime values separately from configured values, per-field sources, and path; `/subagents help` summarizes the single-command interface and the non-sandbox limitation. In RPC mode, bare `/subagents` emits the same bounded status through Pi's notification protocol instead of opening a custom TUI. JSON and print modes do not emit ad hoc command output. Manual edits use `~/.pi/agent/pi-subagents.json` and take effect after reloading Pi:

```json
{
  "blocking": {
    "enabled": false,
    "maxParallelTasks": 8
  },
  "stateful": {
    "enabled": true,
    "transport": "in-process",
    "completionDelivery": "auto-resume",
    "maxAgents": 16,
    "maxActiveTurns": 4,
    "maxDepth": 3,
    "maxChildrenPerAgent": 8,
    "maxMailboxMessages": 100,
    "maxMailboxMessageBytes": 16384,
    "idleTtlMs": 3600000,
    "retentionDays": 30,
    "maxStoredAgents": 50,
    "fleetView": "off",
    "lifecycleArtifacts": "off"
  },
  "cwdPolicy": {
    "consultation": "anywhere",
    "delegation": "trusted-targets"
  },
  "consult": {
    "resources": "project-context"
  }
}
```

The settings UI patches the raw JSON atomically and preserves unknown fields.
It refuses to overwrite malformed or invalid settings.
Supported Pi writers serialize the latest-document read and same-directory temporary-file rename through `pi-subagents.json.mutation-lock`.
Editors and older extension versions do not participate in that lock, so avoid manual edits while a settings save is in progress.
`blocking.enabled` defaults to `true`; set it to `false` for async-only delegation.
`blocking.maxParallelTasks` defaults to `8` and accepts positive integers from `1` through `64`.
It limits worker tasks in one blocking parallel call, while execution still starts at most four workers at once and treats an optional aggregator separately.
`stateful.enabled` also defaults to `true`; its existing `false` value remains the blocking-only workflow.
The detached defaults are `maxAgents: 16`, `maxActiveTurns: 4`, `maxChildrenPerAgent: 8`, `maxDepth: 3`, and `maxStoredAgents: 50`.
`maxDepth` accepts zero or a positive safe integer, while the other four detached limits accept positive safe integers.
Use `/subagents` → **Advanced settings** → **Detached agent limits** to edit them without replacing unknown JSON fields.
The screen shows current-session and configured values separately because changes apply after `/reload`.
It never reloads automatically, because reload can interrupt retained detached work.
Lowering retained, depth, or stored capacity shows a projected recovery warning when current records would be omitted.
Restored parents that already exceed a lowered `maxChildrenPerAgent` remain available, but they cannot gain another child until they fall below the configured limit.
`cwdPolicy.consultation` defaults to `"anywhere"`, `cwdPolicy.delegation` defaults to `"trusted-targets"`, and `consult.resources` defaults to `"project-context"`.
The Settings UI applies a saved change immediately to subsequent launches and refreshes the affected tool descriptions; manual edits take effect on session start or `/reload`.
The UI explicitly states that target/trust settings are not filesystem sandboxing and directs trust changes to Pi `/trust`.
When stateful tools are enabled, their membership stays fixed across spawn, completion, interrupt, close, and mailbox transitions.
This avoids lifecycle-driven tool-schema churn and preserves a stable provider prompt prefix for KV caching.

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start detached work with an optional task-selected thinking level, return an opaque `agentId` immediately, and deliver completion asynchronously. |
| `subagent_send` | Send follow-up work and trigger a new turn on a reusable agent; shared-workspace write conflicts are guarded unless explicitly overridden. |
| `subagent_manage` | Use `action: "list"` to inspect agents, `"interrupt"` to retain an agent after aborting active work, or `"close"` to release it; interrupt/close accept optional `subtree`. |
| `subagent_mailbox` | Use `action: "send"` for queue-only messages that do not start a turn, or `"read"` to read and optionally acknowledge unread messages. |

The action schemas are flat for provider compatibility and reject parameters that belong to another action. For example:

```json
{
  "action": "interrupt",
  "agentId": "sa_example",
  "subtree": true
}
```

```json
{
  "action": "send",
  "agentId": "sa_example",
  "message": "Check the API compatibility note before finishing."
}
```

Use the **Current agents** action in `/subagents` to select a retained agent, inspect its lifecycle metadata, send a follow-up, queue a mailbox message, interrupt active work, close resources, apply subtree variants, or confirm clearing all retained agents.
The manager revalidates the selected agent after prompts and confirmations so cancellation, session replacement, and concurrent lifecycle changes do not apply stale actions.
Set `stateful.fleetView` to `"active"` for an opt-in read-only widget that shows at most five `STARTING` or `RUNNING` agents plus an omission count below the editor.
FleetView never captures terminal input, clears its own widget slot when empty or disabled, and does not run in RPC, JSON, or print mode.
Active turns are FIFO-limited by `maxActiveTurns`; excess retained work remains in `starting` state until a slot is available.
`maxAgents` separately bounds running, queued, and idle records.
`maxChildrenPerAgent` bounds direct children, while `maxDepth` counts nested levels below a depth-zero root.
`maxStoredAgents` bounds sanitized records persisted per session and does not increase live runtime capacity.
`parentId` creates a bounded child relationship; subtree interrupt and close operate child-first.

### Additive event API, ceilings, evidence, and artifacts

The package now provides a process-local `pi-subagents:v1` event API for trusted extensions without adding another model-facing tool.
Use `ping` for discovery, `preflight` for a side-effect-free launch contract, `delegate` for one foreground ephemeral subprocess leaf, `cancel` for one exact request, and the ceiling methods to narrow future agent, tool, or extension capabilities.
No registered ceiling preserves the previous launch policy, while multiple ceilings intersect allow-lists and can never bypass project trust, target policy, consultation read-only tools, or shared-write protection.
Passing `evidence: "attested"` to blocking work, detached spawn, or public delegation asks the child for bounded structured metadata while preserving ordinary output and execution status.
Evidence is explicitly unverified and reports only `attested`, `missing`, or `invalid`.
Set `stateful.lifecycleArtifacts` to `"metadata"` and reload to publish a private bounded status projection without task, prompt, output, error, mailbox, context, credential, environment, or process data.
See [`docs/event-api.md`](./docs/event-api.md) for channels, DTO behavior, cancellation, ceiling semantics, evidence limits, artifact retention, and cleanup.

### Migrating from the previous seven-tool lifecycle surface

The five replaced names are intentionally not registered as aliases. Update explicit prompts and integrations as follows:

| Previous call | Fixed-surface call |
| --- | --- |
| `subagent_list({ includeClosed })` | `subagent_manage({ action: "list", includeClosed })` |
| `subagent_interrupt({ agentId, subtree })` | `subagent_manage({ action: "interrupt", agentId, subtree })` |
| `subagent_close({ agentId, subtree })` | `subagent_manage({ action: "close", agentId, subtree })` |
| `subagent_message({ agentId, message, ... })` | `subagent_mailbox({ action: "send", agentId, message, ... })` |
| `subagent_messages({ agentId, acknowledge, limit })` | `subagent_mailbox({ action: "read", agentId, acknowledge, limit })` |

Persisted agent and mailbox records require no migration. If an explicit prompt in a resumed conversation keeps requesting an old name, update it with the mapping above or start a fresh conversation. To roll back after an upgrade, pin the package version used before the upgrade; for this migration, use `pi install npm:@narumitw/pi-subagents@0.26.0`. The previous release can read the same state directory.

A spawn can request a thinking level explicitly:

```json
{
  "agent": "reviewer",
  "task": "Analyze the cross-package concurrency failure and identify the safest fix",
  "thinkingLevel": "high"
}
```

The requested level is stored with the stateful agent and remains in effect for all follow-ups and after persisted restore. `subagent_send` does not provide a per-turn thinking override; create a new agent when a later task needs a different level.

`subagent_spawn.context` accepts:

- `"none"` (default) — no parent conversation.
- `"all"` — bounded user/assistant text from the active branch.
- `"summary"` — a bounded earlier-context checkpoint plus recent messages verbatim.
- A positive number — the most recent N user turns and related assistant text.

Use `contextEntryIds` to select exact session entries. Supplying IDs without `context` implies `context: "all"`; an explicit `context: "none"` still disables parent context. Stable source IDs are retained so repeated follow-ups do not need to duplicate parent context.

Reasoning, tool results, custom transport messages, and non-text parts are excluded. Text inside `<private>...</private>` and lines containing `[subagent-private]` are omitted before context, mailbox content, or history is persisted.

Stateful execution uses a transport boundary:

- `subprocess` is the default compatibility and rollback path.
- `in-process` uses only public Pi SDK APIs: `createAgentSessionServices()`, `createAgentSessionFromServices()`, `SessionManager.inMemory()`, and normal session lifecycle methods. It isolates conversation/tool selection, not memory or crashes; child failures share the parent Node.js process.
- Child resource loading sets `noExtensions: true`, preventing recursive `pi-subagents` loading and duplicate extension side effects while retaining trust-eligible context/skill resources and the selected agent prompt. Both transports receive the same resolved target-trust boolean: subprocess children get explicit `--approve`/`--no-approve`, and in-process children set the same `SettingsManager.projectTrusted` value.
- Agent model strings use Pi core's CLI resolver, including provider/model patterns, fuzzy matching, custom provider model IDs, and `:<thinking>` suffixes. Thinking level and built-in tool allow-list overrides are applied when the child is created. Parent model/thinking changes are snapshotted for subsequently created children; an existing child keeps its own session configuration.
- Extension/custom tool names are rejected in-process with an actionable recommendation to use `subprocess`; permissions are never silently widened.
- Timeout, parent abort, close, expiry, and session shutdown abort/dispose owned child sessions. A child that does not settle after abort grace is discarded rather than reused.
- In-process startup failures do not silently retry through subprocesses, preventing duplicate side effects. If the loaded Pi core lacks public `createAgentSessionServices()`, `createAgentSessionFromServices()`, or `resolveCliModel()` support, startup fails with an actionable instruction to select `stateful.transport: "subprocess"`.

No private Pi imports, runtime casts, or `ExtensionAPI` monkey-patching are used. Approval policy, sandbox profile, provider-header hooks, extension state, global scheduling, and parent/child transcript switching are not inherited or provided by the in-process transport.

Write-capable agents share the workspace by default. Concurrent write-capable starts in the same cwd are rejected unless `allowConcurrentWrites` is explicitly set. Classification is intentionally conservative: an agent with `bash`, `write`, or `edit` is write-capable even when its task prompt says “read only,” because prompt wording is not a filesystem sandbox. Prefer one detached agent when asynchronous work can be combined. If concurrent work is genuinely required, use the blocking batch only when synchronous outputs justify making the root unavailable, explicitly accept safe detached overlap with `allowConcurrentWrites`, or use isolated worktrees when repository isolation is needed.

Set `workspaceMode: "worktree"` to opt into a disposable detached Git worktree; this requires a clean repository and the worktree is removed on close or session shutdown. The generated path inherits the approved base cwd's trust snapshot. Retained records mark disposable worktrees explicitly, so they are never restored even if cleanup could not remove the generated directory. Shared-workspace retained records store an additive bounded target-trust snapshot for transport and inspection parity; session restore canonicalizes the retained cwd and re-resolves current/saved trust rather than blindly trusting the persisted value. Older records without either field remain readable.

## 📜 Compatibility and failure contract

Existing accepted `subagent` payload shapes remain unchanged.
The `tasks` schema now advertises the absolute 64-item safety bound, while the effective `blocking.maxParallelTasks` value may be lower.
The intentional compatibility change is that an external target without saved trust is rejected by the new default `cwdPolicy.delegation: "trusted-targets"`; set the user-owned policy to `"anywhere"` to restore the preceding target flexibility.

| Mode | Ordering | Failure behavior |
| --- | --- | --- |
| Single | One result. | A failed/aborted/timed-out worker is marked as a tool error while preserving bounded details. |
| Chain | Input order. | Stops at the first failed step; completed steps remain in details. |
| Parallel | Input order, up to `blocking.maxParallelTasks` total workers and at most four active children. | Rejects calls above the configured limit; otherwise collects all task results, and partial worker failure does not discard successful results. |
| Parallel + aggregator | Source input order, then aggregator. | The aggregator runs with both successful outputs and failure descriptions; aggregator failure marks the tool result as an error. |

An aggregator whose `agent` or `task` is empty or whitespace-only is treated as absent, so successful
parallel outputs remain available instead of being replaced by a malformed fan-in failure.

Timeout precedence remains: task/step/aggregator → call → agent setting → `PI_SUBAGENT_TIMEOUT_MS` → 600000 ms. Blocking thinking precedence remains: task/step/aggregator → call → agent setting → child default. Stateful spawn thinking precedence is: `subagent_spawn.thinkingLevel` → agent setting → transport fallback. Project-agent resolution and confirmation behavior is unchanged after target preflight. Blocking and retained result/inspection details add bounded target boundary and effective trust metadata.

## 🤖 Built-in agents

Built-in agents are available without setup and can be overridden by user or project agents with the same name.

| Agent | Purpose | Tools |
| --- | --- | --- |
| `scout` | Read-only codebase reconnaissance. | `read`, `grep`, `find`, `ls`, `bash` |
| `planner` | Grounded implementation plans. | `read`, `grep`, `find`, `ls` |
| `reviewer` | Independent review of code and existing verification evidence. | `read`, `grep`, `find`, `ls`, `bash` |
| `worker` | General-purpose implementation. | Pi default tools |
| `general`, `general-purpose` | Aliases for `worker`. | Pi default tools |

The built-in `reviewer` does not run tests, builds, benchmarks, or formatters. It recommends additional verification commands for the main agent to run instead. Custom agents can override this behavior.

Built-in agents inherit the active/default Pi model instead of forcing a provider-specific model alias, which keeps subprocesses usable across different Pi setups.

## ⚙️ Configure agent tools

Open `/subagents`, choose **Advanced settings**, then **Agent tool permissions** in an interactive
Pi session to edit the tools each subagent may use. The standard bounded multi-select keeps a
one-save draft: toggles do not write until **Save changes**, Escape leaves the draft without writing,
and unavailable configured tool names remain visible and preserved. In TUI mode, type to fuzzy-search
tool names and availability metadata; Save and Discard remain pinned below the matches. These are user
settings stored in `~/.pi/agent/pi-subagents.json` and affect future sessions.

Compatibility: a valid legacy `pi-subagents-config.json` remains readable with a warning and is never modified automatically; rename it to `pi-subagents.json`. The first subsequent settings save writes the canonical file. If both files exist, the new filename takes precedence.

- Select an agent, then press Enter or Space to toggle tools.
- Choose **Save changes** to write the draft, choose **Discard draft** to abandon it, or press Esc to
  return to agent selection without writing.
- Save the default selection to remove a custom override and use the agent defaults again.
- Deselect every tool and save to run that agent with no tools. An explicit empty list remains distinct from an absent list; blank `tools:` or `tools: []` in agent frontmatter also means no tools.

Configured tool names that are not currently registered are preserved, so settings for tools from
other extension sessions are not silently dropped.

## 🧩 Custom agents

Create markdown agent definitions in either location:

- `~/.pi/agent/agents/*.md` for user agents.
- `.pi/agents/*.md` for project-local agents.

Example:

```markdown
---
name: api-reviewer
description: Review API changes for compatibility and tests
tools: read, grep, find, ls, bash
model: sonnet
thinkingLevel: high
---

You are an API review subagent. Do not edit files. Check compatibility,
test coverage, and migration risks. Report PASS/FAIL/PARTIAL with evidence.
```

`tools` accepts either the comma-separated form above or a YAML string array such as `tools: [read, grep]`. An omitted field keeps the agent's default tools; blank, `null`, or `[]` explicitly selects no tools.

`agentScope` is a top-level tool argument supplied per invocation. It is not a setting in
`~/.pi/agent/pi-subagents.json` and does not belong in agent frontmatter. The parent-facing tool
metadata discovers these definitions after session start and labels their source and required scope.
Edit agent files and run `/reload` (or start a new session) to refresh the catalog; there is no live
filesystem watcher. The scope selects which custom agent directories are loaded; built-in agents remain available in every scope:

| `agentScope` | Custom agents loaded |
| --- | --- |
| `"user"` (default) | User agents only. |
| `"project"` | Project-local agents only. |
| `"both"` | User and project-local agents. Project definitions override same-named user definitions. |

For example, invoke a project-local agent with the blocking `subagent` tool:

```json
{
  "agent": "api-reviewer",
  "task": "Review this project's API changes",
  "agentScope": "project"
}
```

Or select the scope when creating a stateful agent with `subagent_spawn`:

```json
{
  "agent": "api-reviewer",
  "task": "Review this project's API changes",
  "agentScope": "project"
}
```

A stateful agent retains the scope selected by `subagent_spawn` for its follow-ups. Every new
blocking `subagent` invocation or `subagent_spawn` call that needs project agents must supply
`agentScope: "project"` or `"both"` again.

Project-local agents require a trusted Pi project. Interactive sessions also ask for confirmation
before using them by default. Passing `confirmProjectAgents: false` as another top-level tool
argument skips that confirmation dialog, but it does not bypass the project trust requirement.

## ⏱️ Runtime limits and thinking levels

Each subprocess has a hard timeout to avoid runaway workers.

- Set `blocking.maxParallelTasks` in `~/.pi/agent/pi-subagents.json`, or use `/subagents` → **Advanced settings** → **Maximum parallel workers**, to allow 1 through 64 worker tasks in one blocking parallel call.
- The worker-count limit defaults to 8 and does not change the fixed four-at-a-time execution concurrency.
- Set `timeoutMs` on the top-level call to apply a default for all jobs.
- Set `timeoutMs` on a task, chain step, or aggregator to override it locally.
- Valid timeout values range from 1 to 2,147,483,647 milliseconds, matching the runtime timer limit.
- If omitted, the default is `PI_SUBAGENT_TIMEOUT_MS`, or `600000` milliseconds (10 minutes) when unset.

Set `thinkingLevel` to request one of Pi's supported levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Blocking subprocess calls pass the resolved value through `--thinking <level>`.

For `subagent_spawn`, the root agent should choose the lowest sufficient level:

| Level | Appropriate delegated work |
| --- | --- |
| `off` / `minimal` | Extraction, formatting, or mechanical work requiring almost no reasoning. |
| `low` | Straightforward, bounded tasks with direct steps. |
| `medium` | Ordinary multi-step research or implementation. |
| `high` | Complex debugging, design, review, or cross-file analysis. |
| `xhigh` | Highly ambiguous, cross-system, or high-risk analysis. |
| `max` | Exceptional hardest tasks where quality clearly outweighs latency and cost. |

Blocking thinking precedence is: task/chain step/aggregator `thinkingLevel` → top-level `thinkingLevel` → agent default from config or frontmatter → Pi subprocess default.

Stateful spawn precedence is: `subagent_spawn.thinkingLevel` → agent default from config or frontmatter → transport fallback. The subprocess transport then uses spawned Pi model/default resolution. The in-process transport delegates configured model parsing to the loaded Pi core and uses its model thinking suffix before the parent thinking snapshot captured when the child is created. An explicit spawn value is retained for the agent lifecycle and wins over all of those fallbacks.

Omit `thinkingLevel` to preserve existing behavior. Reported stateful details show the requested level, not a guarantee of the provider's effective value. Pi still owns model capability clamping; `pi-subagents` does not duplicate capability detection.

On timeout, the extension sends process-group `SIGTERM`, escalates to `SIGKILL` after a five-second grace period if the process has not actually closed, and returns partial bounded messages or stderr collected so far. Parent abort uses the same cleanup path and preserves a structured result.

The child event protocol limits each JSON line to 256 KiB. Captured output uses these defaults:

- final output and fan-in/chain context: 50 KiB;
- stderr: 16 KiB;
- captured messages: 200.

Truncated text includes a `truncated by pi-subagents` marker and details expose `truncated: true`. Inspection and consultation model-facing content also stops at 2,000 lines, whichever limit is reached first. `PI_SUBAGENT_MAX_DEPTH` controls nested delegation depth and defaults to 1; child processes receive `PI_SUBAGENT_DEPTH` automatically.

## 📡 Runtime status

While the `subagent` tool is running, `pi-subagents` publishes compact activity status with `ctx.ui.setStatus("subagents", "...")`. Any statusline extension that reads Pi's generic extension status API can display it; no package-to-package dependency is required.

## 🔒 Safety notes

Subagents have separate processes and context windows, but they are **not security sandboxes**. They run as the same OS user, share the host filesystem and network access, and may conflict if they edit the same files. Tool allow-lists reduce available Pi tools but do not reduce operating-system permissions. `subagent_consult` prevents writes through its Pi tool surface and disables extensions, but it can read accessible paths, call the configured model over the network, and incur cost; its instruction-resource policy is not a filesystem or confidentiality boundary.

The runner explicitly reports policy continuity in result details:

- inherited: process environment;
- overridden when selected: cwd, model, thinking level, and tool list;
- unsupported guarantees: parent approval policy, sandbox profile, and provider headers.

Treat project-local agent prompts like executable project configuration: only enable them in trusted repositories. Stateful project agents require Pi's project trust; interactive use also keeps confirmation enabled by default.

Stateful records are stored as versioned mode-0600 JSON under `~/.pi/agent/pi-subagents-state/` (or the configured Pi agent directory).
Records contain sanitized logical history, never process IDs or credentials.
Corrupt or unsupported state is quarantined, restored agents are always inert `idle` records, and no prior side effect is automatically resumed.
Count projection keeps complete ancestor chains together when stored or restored limits omit older trees.
Retention and count limits are configurable.
Downgrading is safe: older extension versions ignore this separate state directory; clear **Current agents** from `/subagents` before downgrade if the histories should be removed.

## 🗂️ Package layout

```txt
packages/pi-subagents/
├── src/
│   ├── index.ts                  # Pi package entrypoint
│   ├── subagents.ts              # Extension registration and blocking tool schema
│   ├── inspect.ts                # Side-effect-free metadata inspection tool
│   ├── consult.ts                # Synchronous read-only consultation tool
│   ├── consult-policy.ts         # Enforced read-only tool intersection
│   ├── cwd-policy.ts             # Canonical target and saved-trust resolution
│   ├── safe-text.ts              # Shared byte/line/path sanitization
│   ├── stateful.ts               # Detached lifecycle registration and dispatch
│   ├── public-api.ts              # Versioned process-local event protocol and DTOs
│   ├── launch-contract.ts         # Shared safe preflight and execution projection
│   ├── capability-ceiling.ts      # Session-scoped least-capability intersections
│   ├── evidence.ts                # Optional bounded child evidence attestation
│   ├── fleet-view.ts              # Opt-in read-only active-agent widget
│   ├── lifecycle-artifacts.ts     # Optional private metadata projection
│   ├── stateful-guidance.ts      # Detached model-facing workflow guidance
│   ├── stateful-lifecycle.ts     # Runtime disposal and spawn ownership guards
│   ├── stateful-limit-ui.ts      # Detached capacity settings and recovery previews
│   ├── stateful-limits.ts        # Shared detached defaults, labels, and validation
│   ├── stateful-safety.ts        # Project-agent and shared-write safety checks
│   ├── stateful-tool-params.ts   # Consolidated action schemas and validation
│   └── *.ts                      # Package-local discovery, execution, rendering, and settings modules
├── docs/
│   └── event-api.md              # Public event API, ceilings, evidence, and artifact contract
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `subagents.ts`.
`public-api.ts` is also published through the side-effect-free `@narumitw/pi-subagents/api` subpath, while the other source modules remain internal.
Workflow settings remain backward compatible: older files without `blocking.enabled` receive the seven-tool default, and an absent `blocking.maxParallelTasks` keeps the previous eight-worker limit.
Existing `stateful.enabled: false` files expose blocking delegation plus inspection/consultation.
Older package releases ignore and preserve the optional `blocking.maxParallelTasks`, `consult`, `cwdPolicy`, `stateful.fleetView`, and `stateful.lifecycleArtifacts` fields.
The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, subagents, agent delegation, parallel agents, fan-in aggregation, chained agents, isolated subprocesses, AI coding workflow, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
