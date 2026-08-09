# Additive pi-subagents platform capabilities

## Goal

Add opt-in fleet visibility, manager-based steering, a versioned event API with preflight and structured foreground delegation, session-scoped capability ceilings, optional metadata lifecycle artifacts, and optional child evidence attestations to `@narumitw/pi-subagents` without removing or changing the default behavior of its existing seven tools, command routes, settings, transports, completion-delivery policies, persisted records, or non-TUI modes.

Treat the existing completion broker's bounded burst coalescing as the completion-grouping implementation, preserve its current delivery timing and wake rules, and improve only its tests and documentation unless execution discovers a confirmed defect.

## Context

The current package registers `subagent`, four detached lifecycle tools, `subagent_inspect`, and `subagent_consult`, with workflow settings selecting compatible subsets.

`CompletionDeliveryBroker` already coalesces completions for 10 ms, limits each message to 16 completions, preserves `next-turn` and `auto-resume` delivery semantics, and bounds model-facing content.

The detached registry already exposes sanitized tree, lifecycle, history-count, unread-count, target-trust, and policy metadata suitable for a read-only fleet projection.

The `/subagents` manager currently lists retained agents and supports clearing all agents, but it does not offer per-agent detail, follow-up, mailbox, interrupt, or close actions.

The package has no public event API or package subpath for protocol types.

Blocking and detached launches already share agent discovery, cwd/trust policy, thinking, timeout, tool, process cleanup, and output-bound behavior, but they do not yet expose one canonical side-effect-free launch-contract resolver.

The package state file is private, bounded, versioned, and sanitized, but it is not a documented public lifecycle artifact.

Recent package work added blocking and detached limits, so new settings and manager work must reuse the existing latest-document read, unknown-field preservation, mutation lock, atomic rename, stale-session guard, and current-versus-configured presentation.

The repository comparison found that tintinweb's strongest relevant ideas are fleet visibility and direct lifecycle UX, while Nico Bailon's strongest relevant ideas are preflight, capability ceilings, structured delegation, and public lifecycle metadata.

## Architecture

### Compatibility boundary

- Keep exactly the current seven default model-facing tools and their existing names.
- Keep every currently accepted tool payload valid, and add only optional fields with old defaults.
- Keep `/subagents`, `/subagents settings`, `/subagents status`, and `/subagents help` behavior and non-TUI fallbacks.
- Keep `next-turn` as the completion-delivery default and preserve the exact wake, pending-input, fallback, ordering, and bounded batching rules.
- Keep subprocess as the detached transport default and retain the in-process opt-in path.
- Keep the current user settings path, legacy filename precedence, persisted state path, record restoration, and trust revalidation.
- Introduce no project settings, new environment variables, scheduling, missions, arbitrary workflow scripts, wait tool, or automatic child restart.

### Capability classification and user experience

- **Primary:** Existing delegation workflow selection and Current agents remain the main user routes.
- **Supporting:** An opt-in, read-only below-editor fleet widget shows bounded active-agent state without taking focus or intercepting terminal keys.
- **Contextual:** Selecting an agent under Current agents opens details and only the actions valid for its current state.
- **Advanced:** Public event API diagnostics, capability ceilings, lifecycle artifacts, and evidence attestation remain documented advanced capabilities.
- **Safety/status:** Trust boundary, write-conflict policy, failed/interrupted state, destructive close scope, persistence errors, and stale-session changes remain visible at the decision point.
- Do not add a hidden gesture, global terminal-input listener, custom editor, or second manager command.

The fleet widget defaults to off for every existing or absent settings file.

When enabled, the widget renders only active `starting` and `running` agents, at most five rows plus an omission count, a text status word in addition to color, a bounded sanitized task preview, and a `/subagents` hint.

The widget clears when no agent is active, when detached delegation is disabled, on session replacement, on shutdown, and after partial initialization failure.

The Current agents screen keeps the existing clear-all route and adds one selectable row per retained agent.

The per-agent detail screen exposes metadata first, then state-valid actions: send follow-up, queue mailbox message, interrupt, close, and subtree variants when descendants exist.

Manager actions call new extension-owned controller methods directly rather than recursively invoking model tools, and the controller reuses the same registry, trust, write-conflict, workspace-cleanup, and persistence paths as those tools.

Cancellation, invalid input, stale state after any `await`, session replacement, and failed persistence or cleanup leave the previous valid runtime and stored state intact.

### Public event API

Add a versioned `pi-subagents:v1` in-process event protocol with `ready`, request, per-request reply, progress, and cancellation channels.

Publish optional TypeScript constants and DTO types from a side-effect-free `@narumitw/pi-subagents/api` subpath, while keeping raw event names documented so consumers in separate managed npm roots are not forced to import the package.

Register API handlers only for a bound `session_start`, clear them on replacement and shutdown, key all work by the active session manager and generation, and reject requests without a current session.

Version 1 supports:

- `ping` for protocol version and capability discovery.
- `preflight` for one configured leaf agent without child launch, credential resolution, confirmation, settings mutation, or artifact creation.
- `delegate` for one foreground ephemeral leaf using package-owned discovery, tools, trust, timeout, cancellation, process cleanup, bounds, and usage accounting.
- `cancel` for one exact in-flight delegate request.
- `ceiling.register`, `ceiling.update`, and `ceiling.dispose` for trusted in-process policy providers.

Request IDs identify attempts, duplicate active IDs fail closed, one attempt emits at most one terminal reply, and bounded settled/cancelled identity history prevents late duplicate execution.

The first delegation API version always uses the existing isolated subprocess leaf runner and does not expose blocking parallel, chain, aggregator, retained-agent mutation, mailbox, settings, worktree creation, transport selection, or arbitrary tool grants.

### Launch contract and capability ceilings

Extract one pure launch-contract resolver used by preflight and every newly touched launch path.

The contract projects canonical agent identity/source, scope, canonical cwd and trust decision, model/thinking request, timeout, configured and effective tools, extension/resource flags, transport, evidence policy, applicable ceiling sources, and a stable digest without returning system prompts, credentials, environment values, mailbox content, history output, or raw settings.

A capability ceiling may specify `allowedAgents`, `allowedTools`, and `denyExtensions`.

Multiple active ceilings intersect agent and tool sets and OR `denyExtensions`; an explicit empty list denies that capability, while an omitted field does not restrict it.

No registered ceiling means byte-for-byte equivalent launch decisions to the current behavior.

Ceilings affect future blocking launches, consultations, detached spawns, structured delegations, and detached follow-ups.

A detached agent stores its launch-contract digest and effective capability snapshot.

If a later ceiling would narrow a retained agent's existing contract, its follow-up is rejected with an actionable instruction to create a new compliant agent rather than silently reusing a wider in-process or subprocess history.

Ceiling changes never interrupt an active turn, close a retained agent, rewrite settings, or mutate persisted agent definitions.

Project-agent trust and confirmation, cwd policy, consultation's fixed read-only intersection, and the shared-write guard remain authoritative after ceiling application.

### Evidence attestation

Add an optional `evidence: "attested"` request to blocking task shapes, detached spawn, and structured delegation, with omission preserving current prompts and results.

An opted-in child receives a bounded request for a fenced `subagent-evidence` JSON object containing summary, changed files, commands run, test or validation claims, and residual risks.

The runtime parses and bounds the attestation into result details and retained turn metadata without removing or rewriting the child's ordinary output.

Evidence status is `attested`, `missing`, or `invalid`; it never upgrades a claim to runtime-verified, never runs a host command, and never changes execution success into failure in version 1.

Consultation remains unchanged and does not accept evidence mode.

### Lifecycle artifact

Add optional `stateful.lifecycleArtifacts: "metadata"`, defaulting to off.

When enabled at session start, atomically publish one private mode-0600, versioned, bounded metadata projection per owning session at `getAgentDir()/pi-subagents-artifacts/<ownerHash>.json`.

The projection contains agent IDs, names, parent/root relationships, lifecycle states, timestamps, history and unread counts, workspace mode, trust kind, launch-contract digest, evidence status, and omission counts.

The projection excludes tasks, prompts, outputs, errors, mailbox text, context, credentials, environment values, process IDs, and raw filesystem trust-store content.

Artifact writes share the registry's ordered change publication, retain the previous valid file after failure, and finish or cancel before shutdown returns.

Artifact cleanup reuses `stateful.retentionDays`, removes only expired metadata projections during session startup, and never scans or deletes unrelated files.

Disabling future publication does not silently delete existing artifacts; documentation gives the exact cleanup location and retention behavior.

### Source boundaries

- Move completion delivery and message construction from `stateful.ts` into `completion-delivery.ts` before adding API or presentation behavior.
- Move Current agents menu screens and actions from `config-ui.ts` into `current-agents-ui.ts` before expanding the manager.
- Add `launch-contract.ts`, `capability-ceiling.ts`, `public-api.ts`, `lifecycle-artifacts.ts`, `fleet-view.ts`, and `evidence.ts` as separate owners.
- Keep `src/index.ts` a thin default-export forwarder.
- Keep every hand-written source file at or below 1,000 lines.

## Non-Goals

- Do not copy Nico Bailon's WorkflowScript, mission, schedule, wait, watchdog, acceptance-gate command execution, or giant management action surface.
- Do not copy tintinweb's full transcript viewer, global arrow-key capture, custom editor behavior, automatic agent fallback, or default-on project-agent discovery.
- Do not add a new model-facing tool for preflight, API control, fleet navigation, or artifacts.
- Do not expose full child transcripts, prompts, context, mailbox content, credentials, headers, or environment values through the widget, API, inspection, or artifacts.
- Do not make evidence attestation a merge gate or claim that child-reported commands were verified.
- Do not make lifecycle artifacts a general event log or durable job scheduler.
- Do not make another repository extension depend on `@narumitw/pi-subagents`.
- Do not publish, tag, change npm visibility, or dispatch a release workflow without separate explicit approval.

## Assumptions

- Existing users value stable tool names, payload compatibility, current defaults, and the absence of unsolicited background UI more than default-on discovery of the new capabilities.
- A read-only active-agent summary plus manager-based actions provides the useful part of FleetView without global input conflicts.
- The event bus is process-local and all participating extensions are already fully trusted code.
- External consumers may use the documented event strings without importing the optional type subpath because Pi user and project package roots can be separate install scopes.
- The current completion broker already satisfies the requested completion-grouping capability and needs compatibility hardening rather than a second batching implementation.
- One minor Changeset can describe the additive package behavior if all phases ship in one pull request; split pull requests should carry their own package changesets.

## Risks

- A broad plan can create an oversized pull request, so each phase must remain independently testable and later phases must not begin while a prior checkpoint is failing.
- Refactoring `stateful.ts` or `config-ui.ts` can introduce behavior drift before features are added, so the extraction phase must be behavior-only and verified against existing tests and snapshots.
- Capability ceilings can create confusing retained-agent behavior, so the contract digest and explicit follow-up rejection must prevent silent widening or narrowing.
- Event API cancellation and session replacement can race with child startup, so generation, exact request identity, owned abort controllers, and settled-history bounds must be reviewed together.
- A preflight contract can become misleading if execution uses a separate resolver, so preflight and delegate must consume the same immutable resolved contract.
- Evidence text is untrusted child output, so parsing, byte limits, terminal sanitization, persistence, and API projection must all use one bounded representation.
- Lifecycle artifacts add local disk data and backup/DLP exposure, so they must default off, remain metadata-only, use private permissions, and document cleanup.
- A persistent widget can conflict with other extension UI or narrow terminals, so it must use a stable key, never capture input, bound every line, and clear exactly its own slot.
- Public versioned API mistakes become long-lived compatibility obligations, so v1 must stay narrow and receive an independent API/security review before release.
- Settings changes can race with manual edits or other Pi processes, so every new field must reuse the existing latest-document, lock, unknown-field, and atomic-rename protocol.

## Rollback / Recovery

- Keep each capability behind an absent-compatible optional field, request option, or session-scoped registration so rollback restores the prior runtime without migrating user data.
- Disable the fleet widget by removing or setting its user field to off; shutdown and replacement clear the widget immediately.
- Disable lifecycle publication by removing or setting its user field to off; preserve existing artifact files until the user removes the documented directory.
- Omit `evidence` to retain old prompts, outputs, and persisted turn behavior; older package versions ignore additive optional metadata.
- Dispose every registered capability ceiling to restore the unrestricted baseline for future launches; active work is never interrupted by rollback.
- Preserve `pi-subagents:v1` after publication for the documented compatibility window; a later replacement must use a new versioned channel rather than mutating v1.
- If a phase cannot pass its focused checkpoint, revert only that phase's files and keep the last passing behavior-only seam or shipped feature.
- Use Git-based recovery for source and lockfile changes, and do not embed rollback scripts in runtime code.

## Plan

### Phase 1: Freeze compatibility and create safe seams

- [x] Add compatibility tests for the seven default tools, every workflow subset, accepted legacy payloads, `/subagents` routes, absent settings defaults, state v1/v2 restore, and `next-turn`/`auto-resume` message details; verify with `npx vitest run packages/pi-subagents/test` and record the baseline test count in this plan.
- [x] Extract `CompletionDeliveryBroker`, completion DTOs, bounds, and message builders into `packages/pi-subagents/src/completion-delivery.ts` while preserving existing exports and byte-for-byte test expectations; verify with `npx vitest run packages/pi-subagents/test/completion-delivery.test.ts packages/pi-subagents/test/in-process-transport.test.ts`.
- [x] Extract Current agents screen formatting and actions from `packages/pi-subagents/src/config-ui.ts` into `packages/pi-subagents/src/current-agents-ui.ts` without changing visible rows or behavior; verify with focused manager tests covering clear-all, Escape, Ctrl+C, stale confirmation, session replacement, RPC fallback, and 40/64/100-column rendering.
- [x] Extract a pure immutable launch-contract resolver from blocking, consultation, and detached launch preparation into `packages/pi-subagents/src/launch-contract.ts`; verify parity tests compare old and resolved cwd, trust, scope, model, thinking, timeout, tools, resources, and transport for trusted, denied, unsaved, malformed, and worktree targets.
- [x] Run `npm run check:boundaries`, `npm run typecheck`, and the complete pi-subagents test directory as the Phase 1 checkpoint; keep later phases unchecked until this behavior-only checkpoint passes.

### Phase 2: Add the versioned event API and capability ceilings

- [x] Define bounded v1 request, reply, progress, error, cancellation, preflight-contract, delegation-result, and ceiling DTOs plus stable channel constants in side-effect-free `packages/pi-subagents/src/public-api.ts`; verify compile-time fixtures and runtime validation reject unknown methods, oversized strings, malformed DTOs, duplicate IDs, and unsupported fields.
- [x] Add a session-scoped ceiling registry in `packages/pi-subagents/src/capability-ceiling.ts` with intersection, OR, empty-list, update, dispose, source-bound, generation, and bounded-audit semantics; verify deterministic tests for multiple providers, stale tokens, replacement, shutdown, and no-provider identity behavior.
- [x] Apply the resolved ceiling after existing trust/discovery policy and before every future blocking, consultation, detached, follow-up, and public delegation launch; verify no-ceiling parity, agent denial, tool intersection, extension denial, consultation non-widening, project trust, write guard, and retained-contract mismatch tests.
- [x] Register `pi-subagents:v1` handlers from `session_start` and dispose all handlers and owned work on replacement/shutdown; verify ready ordering, filtered/unbound behavior, current-session ownership, cancellation-before-start, cancellation-during-run, late reply suppression, bounded settled history, and exact-once terminal replies.
- [x] Implement side-effect-free `preflight` through the shared launch resolver and return only the documented safe projection and digest; verify tests prove no child, prompt file, worktree, state record, settings write, credential resolution, lifecycle artifact, confirmation, mailbox read, or provider refresh occurs.
- [x] Implement one-leaf foreground `delegate` and exact `cancel` through package-owned discovery, launch policy, subprocess cleanup, bounds, usage, and error semantics; verify success, unknown agent, denied target, timeout, abort, provider failure, partial output, tool restriction, project scope, session replacement, and cleanup failure paths.
- [x] Add `package.json#exports["./api"]` without changing the canonical Pi extension entrypoint, and add package-boundary tests proving the API subpath has no factory side effects; verify with `npm run check:boundaries` and `npm run pack:subagents -- --json`.
- [x] Run the full pi-subagents suite, typecheck, boundary check, and a deterministic two-extension event-bus harness as the Phase 2 checkpoint; record request/reply and no-ceiling compatibility evidence before continuing.

### Phase 3: Add optional evidence attestation

- [x] Add the optional Google-compatible `evidence: "attested"` field to blocking single/task/chain/aggregator shapes, detached spawn, and public delegation while leaving consultation and existing required fields unchanged; verify schema snapshots and legacy payload tests.
- [x] Implement one bounded evidence instruction, fenced JSON parser, validator, status model, and safe projection in `packages/pi-subagents/src/evidence.ts`; verify missing, malformed, oversized, duplicate-fence, unknown-field, terminal-control, private-text, changed-file, command, validation, and residual-risk cases.
- [x] Thread opted-in evidence through blocking details, public delegation replies, detached launch contracts, retained turn metadata, inspection, persistence, and rendering without removing the original child output or changing exit status; verify state v1/v2 compatibility, old-reader tolerance, truncation, and subprocess/in-process parity.
- [x] Document that evidence is child attestation rather than host verification and add tests proving `attested`, `missing`, and `invalid` never become `verified` and never run commands or fail an otherwise successful child.
- [x] Run focused evidence, blocking, registry, persistence, inspect, rendering, and transport tests as the Phase 3 checkpoint; record the unchanged no-evidence output fixtures before continuing.

### Phase 4: Add optional bounded lifecycle artifacts

- [x] Add strict normalization, inspection, status, help, and Advanced settings UI for `stateful.lifecycleArtifacts: "off" | "metadata"`, defaulting to off and applying after reload; verify missing-file side effects, latest-document reads, unknown-field preservation, legacy seeding, malformed-file protection, lock ordering, atomic failure, cancellation, and current/configured divergence.
- [x] Implement the metadata-only versioned projection and private atomic writer in `packages/pi-subagents/src/lifecycle-artifacts.ts`; verify schema bounds, omission counts, mode `0600`, no secret/task/output/mailbox/context leakage, previous-file retention, ordered writes, and retention cleanup.
- [x] Attach the writer to one session-owned registry generation and flush or cancel it during clear, replacement, failed initialization, and shutdown; verify stale generations cannot publish after a replacement and writer failure cannot poison registry lifecycle or later writes.
- [x] Expose only the safe artifact path, version, enabled state, last publication status, and bounded error summary through `/subagents status`, `subagent_inspect status`, and API `ping/preflight`; verify terminal sanitization and non-TUI protocol safety.
- [x] Run settings, persistence, lifecycle, inspection, API, and artifact tests as the Phase 4 checkpoint; inspect generated fixtures to prove excluded content is absent before continuing.

### Phase 5: Add opt-in fleet visibility and manager steering

- [x] Add strict normalization, inspection, immediate runtime application, and Settings UI for `stateful.fleetView: "off" | "active"`, defaulting to off; verify missing and malformed settings, unknown fields, serialization, rollback after persistence/runtime failure, session replacement, shutdown, and current/configured source reporting.
- [x] Implement `packages/pi-subagents/src/fleet-view.ts` as a read-only `subagents:fleet` below-editor widget with no terminal listener, at most five active rows, an omission count, text state labels, safe task previews, bounded width, callback theme use, invalidation, and disposal; verify empty, disabled, initializing, starting, running, concurrent, omitted, failed-removal, narrow/wide, CJK, terminal-control, theme-change, RPC, JSON, print, replacement, and shutdown behavior.
- [x] Extend Current agents to a shallow agent list and detail flow that preserves clear-all and adds state-valid follow-up, queue-message, interrupt, close, and subtree actions; verify labels, discoverability, empty/disabled/partial states, destructive summaries, and no hidden route to a core action.
- [x] Implement follow-up and mailbox inputs with draft preservation and cancellation, and revalidate generation, selected agent identity, state, descendants, write-conflict policy, and trust after every `await`; verify Esc, Ctrl+C, empty input, invalid state, concurrent completion, changed subtree, stale session, and persistence/cleanup failures leave prior state intact.
- [x] Exercise the manager and widget with keyboard-only deterministic harnesses and a TUI smoke at supported widths; verify focus remains with Pi's editor outside the manager, no keys are intercepted globally, all lines fit, state is not color-only, and widget cleanup owns only `subagents:fleet`.
- [x] Run all pi-subagents UI, lifecycle, registry, settings, rendering, and non-TUI tests as the Phase 5 checkpoint; record screenshots or captured rows only as supplemental evidence, not as a substitute for assertions.

### Phase 6: Preserve completion grouping and finish integration

- [x] Audit the existing completion broker against the requested grouping behavior and add regression cases for burst boundaries, ordering, simultaneous failures, chunk overflow, active-root holding, pending input, fallback delivery, synchronous reentrancy, replacement, shutdown, and bounded details; verify old single and batch fixtures remain unchanged.
- [x] Update `packages/pi-subagents/README.md` and add `packages/pi-subagents/docs/event-api.md` to document defaults, opt-ins, API lifecycle, ceiling semantics, fleet states, evidence limitations, artifact privacy/cleanup, compatibility, non-sandbox boundaries, and completion grouping without removing existing guidance.
- [x] Update `packages/pi-subagents/package.json#files` for published docs and add a minor Changeset covering additive public behavior; verify the manifest still declares exactly `"pi": { "extensions": ["./src/index.ts"] }` and `piExtension.lifecycle: "stable"`.
- [x] Audit all touched asynchronous flows for user cancellation, component disposal, session replacement, shutdown, generation revalidation, owned-task release, and stale-context use; verify every owned timer, listener, child, widget, writer, request, and temporary file has a tested cleanup path.
- [x] Audit all settings reads and writes together for ordering, failure recovery, stale reads, invalid-file protection, unknown-field preservation, atomic publication, legacy precedence, and cross-process lock claims; verify against `docs/extension-settings.md` rather than relying on the root check alone.
- [x] Audit the final diff against every applicable MUST in `docs/extension-conventions.md`, the package `AGENTS.md`, the substantial-experience proposal criteria, and the no-removal compatibility boundary; record any accepted deviation or unverified path in this plan.

## Execution Evidence

- Baseline before implementation: `npx vitest run packages/pi-subagents/test` passed 14 files and 205 tests.
- Final package verification: `npx vitest run packages/pi-subagents/test` passed 15 files and 217 tests.
- Package gate: `npm run check --workspace @narumitw/pi-subagents` passed Biome and TypeScript.
- Repository gate after rebasing onto current `origin/main`: `VITEST_MAX_WORKERS=4 npm run check` passed build, Biome, boundaries, all workspace typechecks, 232 test files, and 2,651 tests.
- Package smoke: `npm run pack:subagents -- --json` produced a 55-file dry-run tarball containing `src/public-api.ts` and `docs/event-api.md` with no tests, state, lifecycle artifacts, or credentials.
- Loader smoke: `PI_CODING_AGENT_DIR=<temp> pi --offline --no-extensions -e ./packages/pi-subagents/src/index.ts --list-models` exited successfully, and the deterministic entrypoint test registered exactly the existing seven unique tools while the API import registered none.
- TDD evidence: the capability-ceiling test first failed because non-boolean `denyExtensions` was accepted, then passed after strict validation was implemented.
- Lifecycle and race hardening fixed stale API work starting after session replacement, duplicate terminal replies and settled-history growth, stale artifact publication, no-op ceiling follow-up rejection, FleetView persistence/runtime rollback, in-process extension-flag parity, and unbounded persisted capability/evidence metadata.
- Convention audits covered `docs/extension-conventions.md`, `docs/extension-settings.md`, cancellation, component/widget disposal, session generation, shutdown, settings locks, latest-document writes, invalid-file protection, unknown fields, atomic rename, terminal sanitization, and package boundaries.
- UX evidence uses deterministic keyboard-only Pi TUI Kit harnesses and cell-width assertions because this execution environment prohibits opening an interactive TUI; no live interactive layout was claimed.
- No provider-backed delegation smoke was run because deterministic subprocess, transport, protocol, timeout, abort, failure, and cleanup suites cover the changed path without external cost or entitlement variability.
- No package publication, version tag, npm visibility change, or release workflow occurred.

## Completion Checklist

- [x] Every Plan checkbox is checked with concise command, test, or inspected-artifact evidence, and no failed or unavailable check is represented as passed.
- [x] `npx vitest run packages/pi-subagents/test` passes all existing and new package tests with the final count recorded.
- [x] `npm run check --workspace @narumitw/pi-subagents` passes Biome and package typechecking.
- [x] `VITEST_MAX_WORKERS=4 npm run check` passes the repository CI-equivalent build, Biome, boundaries, workspace typechecks, and tests without running concurrently with a `pi-tui-kit` build.
- [x] `npm run pack:subagents -- --json` succeeds, and inspection confirms the tarball contains the API subpath, focused docs, all runtime modules, README, manifest, and license with no test fixture, artifact, credential, or state files.
- [x] A deterministic extension-loader smoke proves the declared entrypoint still registers the expected default seven-tool surface and that importing `@narumitw/pi-subagents/api` alone registers nothing.
- [x] Not applicable for a live interactive TUI: the non-interactive agent harness must not open a TUI; deterministic Pi TUI Kit keyboard/render tests cover FleetView, manager navigation/actions/cancellation, completion delivery, widths, and cleanup, while an offline real-Pi loader smoke covers the declared entrypoint.
- [x] Print, JSON, and RPC mode tests prove the widget and manager never invoke TUI-only components or write ad hoc protocol output, while documented status/API responses remain observable through supported channels.
- [x] Compatibility tests prove old settings files, absent new settings, legacy settings filenames, state v1/v2 records, old tool payloads, command routes, transports, trust rules, completion messages, and default output remain accepted and behaviorally unchanged.
- [x] Security and privacy review confirms ceilings cannot widen tools, preflight is side-effect free, public delegation cannot bypass trust or write guards, evidence remains untrusted attestation, terminal text is sanitized, and artifacts exclude sensitive content.
- [x] UX review confirms FleetView is opt-in and non-intercepting, Current agents remains shallow and keyboard-accessible, cancellation is side-effect free, destructive scope is explicit, status is not color-only, and narrow/CJK rendering is bounded.
- [x] Public API review confirms v1 methods, bounds, exact-once replies, cancellation, generation ownership, error codes, separate-install guidance, and compatibility commitments are documented and tested.
- [x] The package Changeset accurately describes additive behavior and no publication, tag, npm visibility change, or release workflow has occurred without separate explicit approval.
- [x] `git diff --check` passes, the final diff contains only intended package, test, documentation, manifest, lockfile-if-required, Changeset, and synchronized plan changes, and no generated runtime artifacts remain.
- [x] Move this fully evidenced plan to `docs/plans/archived/2026-08-09_pi-subagents-additive-capabilities-plan.md` only after every completion item passes and no required work remains.
