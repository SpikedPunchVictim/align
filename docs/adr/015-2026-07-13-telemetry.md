# ADR 015: Telemetry / 360-Feedback Loop (Local-Only, Opt-In)

**Status**: Accepted

## Context

Every promotion decision this project has made so far — `arch.metric` (max-LOC), `security.manifest.*`'s
two promoted rule kinds, `--untrusted` mode itself — was justified by one-shot spike evidence: a probe run
against a handful of repos, measured once, written up, and used to decide what ships next. That evidence is
real but narrow: it says nothing about what happens across weeks of *actual* use — which rules fire
constantly and get fixed fast, which fire once and get baselined forever (noise, not signal), which never
fire at all (dead weight in the ruleset), or how check latency holds up as a repo grows. `IMPLEMENTATION_PLAN.md`'s
telemetry Design Reserve entry frames this precisely: "the project has run entirely on one-shot spike
evidence; this captures LONGITUDINAL real-usage data during the user's live kluster development, which the
user brings back to the coordinator as 360 feedback."

Collecting that data is only acceptable under the same trust posture every other part of this project
already holds itself to. ADR 001 frames align's whole reason to exist as being a trustworthy oracle — "trust
that doesn't need re-checking." ADR 014 hardened align's own config-execution surface specifically because
an oracle that becomes a trust liability defeats its own purpose. A telemetry feature that silently phoned
home would be exactly that: the one thing in this codebase that would make a security-conscious user (or an
agent following `--untrusted` discipline) right to stop trusting align. This ADR is the design for closing
the evidence gap without ever opening that liability.

## Decision

**Local file only. Never a network call, ever.** Telemetry writes one append-only JSONL file,
`.align/telemetry.jsonl`, in the repo being checked — no phone-home, no external host, no `fetch`/
`XMLHttpRequest`/`WebSocket`/raw socket anywhere in the telemetry code path. This is asserted, not just
documented: `packages/core/test/telemetry/network-abstinence.test.ts` and
`packages/cli/test/telemetry/network-abstinence.test.ts` scan every file under `packages/{core,cli}/src/telemetry`
(plus the CLI command files that call into it) for a fixed list of network-primitive patterns and fail the
suite if any appear. A future contributor who adds a network call to this surface gets a test failure, not a
silent regression.

**OFF by default; four ways to turn it on, one to force it off.** `ALIGN_TELEMETRY=1` (env) OR
`telemetry: true` (a named export in `align.config.ts`, the same "scan-time/CLI-behavior concern, not a
rule-evaluation concern" carve-out `excludes`/`hostRules` already use, ADR 002) OR `--telemetry` (a per-command
flag) enables it; `--no-telemetry` overrides all three unconditionally. The precedence is resolved in two
steps (`packages/cli/src/telemetry/resolve.ts`) because `align.config.ts` isn't loaded yet at the point flags
are parsed — `resolveTelemetryPreConfig` decides everything flags/env can decide up front (returning
`undefined` only when it must defer), then each command finishes the resolution once `loadConfig` has run.
`align check --untrusted` never calls `loadConfig` at all (ADR 014) — so under `--untrusted`, only
`--telemetry`/`ALIGN_TELEMETRY` can enable telemetry; `align.config.ts`'s toggle is structurally unreachable
in that mode, the same way `hostRules` is.

**Emitter is pure core; I/O is the CLI's job.** `packages/core/src/telemetry/` defines the event
discriminated union, the envelope, and a pure `serializeTelemetryEvent: envelope -> JSON-line string` — zero
`node:fs`, zero `Date.now()`, zero network primitive, matching every other file under `packages/core/src`
(ARCHITECTURE.md §5: core stays framework-free). `ts` (envelope timestamp) and `sessionId` are both
*injected* — core never calls `Date.now()`/`crypto.randomUUID()` itself; the CLI (the imperative shell)
supplies both. `packages/cli/src/telemetry/` is where the actual file gets written
(`appendTelemetryLine`, `packages/cli/src/align-dir.ts`) and where the enable/disable decision is made.

**The envelope (cross-session comparability).** Every event carries
`{ schemaVersion, sessionId, alignVersion, rulesetIrHash, ts, command, event }`. `rulesetIrHash` reuses the
exact `sha256Hex` content-hash function `.align/rules.lock.json`'s own divergence detection already uses
(`packages/core/src/build/hash.ts`) rather than inventing a second hashing scheme — `RulesetIR` is always
zod-parsed, function-free JSON (ADR 002), so hashing its `JSON.stringify` is deterministic for a given
ruleset. `sessionId` is generated once per CLI process (`crypto.randomUUID()`, cached at module load via
ESM's per-process module singleton — `packages/cli/src/telemetry/process-context.ts`) so every event across
however many commands one invocation touches shares an id. This is what makes "did a change help? which
rule-config was live?" answerable later by segmenting the JSONL on `alignVersion`/`sessionId`.

**Events, one JSON line each** (`packages/core/src/telemetry/types.ts`):

- `check` — verdict, per-gate `{gate, status, newCount, baselinedCount, passCount}`, `wallMs`, `scope`
  (always `'all'` in v1 — `align check` only ever does a full fresh scan, ADR 005; `'changed'`/`'files'` are
  reserved discriminants for a future scoped-check mode, the same reserve-pending-evidence doctrine as
  `GATE_KINDS`'s `types`/`lint`/`format`), ungrounded-component count, advisory counts by kind. Real latency
  DISTRIBUTION across many invocations, not one cold spike number.
- `violation-appeared` / `violation-resolved` — `ruleId`, `component` (when the violation kind has one),
  `file`, `violationFingerprint` (the same stable `Violation.id` ADR 006 already defines: a snippet hash,
  stable under unrelated edits). Computed by **diffing** the current check's non-baselined violation set
  against the previous check's set, persisted in `.align/telemetry-state.json`
  (`packages/core/src/telemetry/diff.ts`'s pure `diffViolationState`, called from
  `packages/cli/src/telemetry/violations.ts`). This is the mechanism that makes offline time-to-green
  analysis possible: an `appeared` and the `resolved` that later shares its fingerprint are the same
  violation's whole lifecycle, correlatable across process invocations without keeping anything in memory
  between them.
- `baseline` — `action` (`accept`/`prune`), `ruleScope` (when `--rule` scoped it), `counts`.
- `build` — `doc`, `structuralChanges` (added+changed+removed rule count — provenance-only edits excluded,
  the same distinction `RuleDiff.provenanceOnlyChanged` already draws for the same live-session reason),
  `provenanceOnlyChanges`, `impactDelta {newViolations, maskedBaselined}`.
- `error` — `errorKind` (`gate-error` | `exception` | `untrusted-refusal` | `unknown-host-rule` |
  `ungrounded-fail` | `unknown`; the last two are reserved — today's guard-step failures surface as
  `gate-error`, same reserve doctrine as above), a SHORT message (truncated defensively; never a snippet,
  never file contents), `command`.
- `agent` — `attempts` (real `FixProvider` calls, `MemoizingFixProvider.providerCallCount` — a memoized
  cache hit for identical retry state is not an attempt, since no model call happened), `converged`,
  `iterations` (file-group count), `escalated`/`escalationReason`, and an optional `usage`
  `{inputTokens, outputTokens}`. `AnthropicFixProvider` now accumulates `response.usage` across every real
  API call and exposes `getUsageTotals()`; the field is **omitted, never fabricated**, when no real call was
  made (`nothing-to-fix`, `--dry-run`'s planning-only calls still populate it since they do call the model) —
  closing the observability gap a live Kimi K2.7 run flagged (`IMPLEMENTATION_PLAN.md`'s Stage 4 log).

**Paths and rule ids only, never file contents** — every event above carries structured identifiers
(`file`, `ruleId`, `doc`, counts) and, for `error`, a short message; none carries a source snippet or full
file text. This is ADR 007's payload discipline applied to a new surface, not a new rule: "no `message`
prose field duplicating structured fields," extended here to "no field ever holds file contents, full stop"
since a telemetry log — unlike a check payload — is written to disk and could be forwarded manually by the
user, so the bar is even less permissive than an ephemeral machine payload.

**One recorder, not one emit-call per command.** `packages/cli/src/telemetry/recorder.ts`'s
`TelemetryRecorder` is the single place that builds an envelope and calls `appendTelemetryLine` — every
command (`check`, `baseline accept`/`prune`, `build`, `agent run`) constructs one via
`createTelemetryRecorder(rootDir, command, preConfig, configTelemetry)` and calls `.record(event, opts)`
with its own domain event; no command touches the JSONL file or builds an envelope itself. This is the
"ONE wrapper... over scattering emit calls" instruction from the telemetry spec, applied as: the resolution
+ envelope + write logic exists in exactly one class, reused identically everywhere, even though each
command is still the natural place to *decide what event to build* (it already has the `CheckRun`/
`AgentRunResult`/etc. in hand).

**`align telemetry [--file <path>] [--json]`** (`packages/cli/src/commands/telemetry.ts`) is the report the
coordinator/user actually reads: check-latency percentiles (p50/p90/p99), top-firing rules, time-to-green
per rule (appeared→resolved deltas, averaged/medianed per rule), dead rules (rules in the *currently active*
ruleset — `loadConfig` at report time — that never appear in any `violation-appeared` event), baseline-vs-fix
ratio, and friction ranking (`error` events grouped by `errorKind`). Segmentable by `sessionId`/`alignVersion`
(per-segment check-latency breakdowns). Malformed lines are skipped and counted, not fatal — this is a
read-only analysis tool over an accretive log, not a schema boundary anything else depends on, so it doesn't
get `readGeneratedRules`'/`readRulesetIr`'s "corrupted is never treated as absent" treatment.

**Gitignored by default, both sides.** `.align/telemetry.jsonl` and `.align/telemetry-state.json` are in
align's own `.gitignore`; `align init` idempotently appends the same two entries to the target repo's
`.gitignore` (creating one if absent) via `ensureTelemetryGitignored`
(`packages/cli/src/init/gitignore.ts`) — never a blanket `.align/` ignore, since every other `.align/*`
artifact (`baseline.json`, `generated-rules.json`, `ruleset-ir.json`) is deliberately committed.

## Alternatives considered

- **Send telemetry to a hosted collector** (even an opt-in one, even one align's own team operated). Rejected
  outright — this is the one option ADR 001/014's whole trust posture forecloses; the task that commissioned
  this ADR states the non-negotiable directly: "NEVER any network call, ever."
- **No persisted state file — recompute appear/resolve from two full check runs kept in memory.** Rejected:
  the whole point is longitudinal data *across separate CLI invocations* over days/weeks of real
  development; nothing survives between two separate `align check` process runs except the filesystem.
  `.align/telemetry-state.json` is the minimal persisted shape (`fingerprint`, `ruleId`, `file`, `component`
  — not full `Violation` objects) needed to name a transition without re-deriving it from a snippet.
- **Treat a corrupt/missing `telemetry-state.json` like `readGeneratedRules` treats a corrupt
  `generated-rules.json`** (throw, never silently treat as absent). Rejected specifically for this file: a
  lost or corrupted *portable ruleset artifact* silently under-enforces a rule (false-green class ADR 008
  guards). A lost or corrupted *telemetry cache* just means one check's worth of transitions look like
  everything appeared fresh — self-healing on the very next check, and the whole feature is advisory
  analysis, not enforcement. Matching the stricter discipline here would make an optional, best-effort
  feature able to crash a check run, which is the wrong trade.
- **Emit telemetry from inside `packages/core`'s `GateOrchestrator.check`.** Rejected: would require core to
  do file I/O and own the enable/disable decision, breaking the framework-free core boundary ARCHITECTURE.md
  §5 already holds every other feature to. The CLI already receives the full `CheckRun`/`AgentRunResult`
  after each domain call — building the event from data already in hand is no more work than building it
  inside core would be, and keeps `packages/core` dependency-free of any I/O concern.

## Consequences

- A future rule-kind promotion decision (the same "one-shot spike vs. longitudinal evidence" gap this ADR
  closes) can now cite real fire/fix/dead-rule counts from a live repo instead of only a probe run — the
  `align telemetry` report is designed to be that evidence source.
- `AnthropicFixProvider` now holds a small piece of mutable state (`usageTotals`) it didn't before — scoped
  to token-usage accounting only, never touched by the pure `run.ts` state machine (`FixProvider`'s interface
  is unchanged; `packages/cli/src/commands/agent.ts`, the composition root, is the only caller that reads
  `getUsageTotals()`).
- Every future telemetry event kind must pass the same two bars this ADR sets: (1) local-file-only, provably
  so via the network-abstinence tests, and (2) paths/rule-ids/counts only, never file contents — a checklist
  item for whoever adds the next event kind, not a one-time review.
- `.align/telemetry.jsonl` can grow unbounded over a long dogfood session; no rotation/truncation exists yet
  — deferred until real usage shows it matters (this project's own "reserve pending evidence" doctrine
  applied to itself).

## Evidence

No spike measurement (this is a security/privacy-posture design + a new local-analysis surface, not a
rule-kind promotion) — validated by the test suite added alongside this ADR (network-abstinence,
corrupt/missing-state-file handling, resolve-precedence unit tests, and an end-to-end
check→edit→check→check sequence asserting a real appeared→resolved time-to-green delta) and by a dogfood
run against align's own repo: telemetry enabled, a violation introduced then fixed across three `align
check` invocations, `align telemetry` correctly reporting one `topFiringRules` entry, one `timeToGreen`
entry, and zero `deadRules` for the one rule that fired.
