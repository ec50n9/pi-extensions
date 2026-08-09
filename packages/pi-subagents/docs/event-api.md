# pi-subagents event API v1

`@narumitw/pi-subagents` exposes an optional process-local event API for trusted Pi extensions.

The API does not add a model-facing tool and is not a network server.

Pi user and project packages can live in separate npm roots, so consumers may use the channel strings directly instead of importing this package.

Importing `@narumitw/pi-subagents/api` only provides constants, DTO types, and the explicit registration helper; it does not register the extension or any tool.

## Channels

- Request: `pi-subagents:v1:request`.
- Reply: `pi-subagents:v1:reply`.
- Progress: `pi-subagents:v1:progress`.
- Ready: `pi-subagents:v1:ready`.

A consumer should register its `ready` listener before its own `session_start` work, then send requests only after the session's ready event.

Each request has a bounded `requestId`, a `method`, and an optional `payload`.

Request IDs identify one session-local attempt and must not be reused.

One request ID emits at most one terminal reply.

Duplicate active IDs abort the original attempt and fail closed, while duplicates of settled IDs are ignored.

Session replacement and shutdown abort active delegation, dispose listeners, clear capability ceilings, and suppress late replies from the old generation.

## Methods

### `ping`

`ping` returns the protocol name, supported methods, effective capability ceiling, detached runtime status, FleetView mode, and safe lifecycle-artifact status.

### `preflight`

`preflight` accepts one leaf request with `agent` and optional `cwd`, `agentScope`, `thinkingLevel`, `timeoutMs`, `evidence`, and `confirmProjectAgents`.

It returns the exact safe launch projection used by delegation, including effective tools, trust, transport, ceiling sources, and a stable contract digest.

It does not start a child, resolve credentials, create a prompt file or worktree, mutate settings or retained state, request confirmation, or publish an artifact.

### `delegate`

`delegate` accepts the preflight fields plus a required bounded `task`.

Version 1 always runs one foreground ephemeral subprocess leaf.

It does not expose parallel, chain, aggregator, retained-agent mutation, mailbox, settings, worktree creation, transport selection, or arbitrary tool grants.

A trusted project is still required for project-agent scope, and normal target, trust, confirmation, timeout, process cleanup, output, and usage policies remain authoritative.

Project-agent confirmation defaults to enabled, preflight reports when it is required, and a non-UI caller must set `confirmProjectAgents: false` explicitly in a trusted project rather than bypassing confirmation silently.

A protocol-level `ok: true` means delegation completed as a request; child failures remain explicit in the returned bounded `isError` details.

### `cancel`

`cancel` accepts `{ "targetRequestId": "..." }` and aborts that exact active delegation attempt.

A successful cancel reply reports whether the target was active.

### Capability ceiling methods

`ceiling.register` accepts a bounded `source` and a ceiling object, then returns an opaque session-local token.

`ceiling.update` replaces the ceiling associated with that token.

`ceiling.dispose` removes the token.

A ceiling may contain `allowedAgents`, `allowedTools`, and `denyExtensions`.

Multiple providers intersect the agent and tool lists and OR `denyExtensions`.

An omitted list does not restrict that capability, while an explicit empty list denies all entries.

Ceilings only narrow future launches and never bypass project trust, target policy, consultation's read-only tool set, or detached shared-write protection.

Active turns are not interrupted by a later ceiling update.

A retained agent whose stored launch contract is wider than the current ceiling rejects follow-up and must be replaced with a new compliant agent.

## Example

```typescript
const requestId = crypto.randomUUID();

const dispose = pi.events.on("pi-subagents:v1:reply", (data) => {
  const reply = data as { requestId?: string; ok?: boolean; result?: unknown };
  if (reply.requestId !== requestId) return;
  console.log(reply);
  dispose();
});

pi.events.emit("pi-subagents:v1:request", {
  requestId,
  method: "preflight",
  payload: { agent: "scout", agentScope: "user" },
});
```

## Evidence attestation

Passing `evidence: "attested"` asks the child to append one bounded `subagent-evidence` JSON block.

The parsed metadata can report a summary, changed files, commands, validation claims, and residual risks.

The status is `attested`, `missing`, or `invalid` and is never described as verified.

The runtime does not execute commands to validate the child's claims and evidence does not change execution success.

## Lifecycle metadata artifact

Set `stateful.lifecycleArtifacts` to `"metadata"` and reload to publish a private versioned projection at `~/.pi/agent/pi-subagents-artifacts/<ownerHash>.json`.

The artifact contains lifecycle relationships, state, counts, trust kind, contract digest, and evidence status.

It excludes tasks, prompts, outputs, errors, mailbox text, context, credentials, environment values, and process IDs.

Files use mode `0600`, atomic replacement, bounded content, and the configured `stateful.retentionDays` cleanup window.

Turning publication off does not delete an existing artifact immediately.

Remove only the `pi-subagents-artifacts` directory when no Pi session is using it if immediate local cleanup is required.

## Trust boundary

The event bus is process-local, but participating extensions are executable trusted code.

This protocol is a coordination and least-capability boundary, not an operating-system sandbox.
