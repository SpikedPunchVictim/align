# ADR 008: Gate Model

**Status**: Accepted

## Context

The plan's full gate stack is `parse → format → lint → types → architecture → security → tests`, cheapest
first, with declared dependencies rather than hardcoded short-circuit positions. ADR 001 scopes v1 to
architecture-first — no tool-wrapping gates ship yet — but the *contract* (`GateStatus`, `GateResult`,
dependency declarations, `error` semantics) has to be fixed now, because Stage 1/3 must slot
format/lint/types/security/tests into this contract without a payload-shape rewrite, and because the
distinction between a code problem and an environmental problem is safety-critical regardless of how many
gates exist yet.

## Decision

**v1 gates: `parse` and `architecture` only.** Every later gate is designed in `IMPLEMENTATION_PLAN.md`
(format/lint/types/security/tests) and slots into this same `GateResult` shape when its stage starts —
this ADR is the contract those gates implement against, not a re-scoped version of it.

```ts
type GateStatus = 'green' | 'red' | 'error' | 'skipped';

interface GateResult {
  readonly gate: 'parse' | Category;   // Category = 'architecture' | 'security' | 'types' | 'lint' | 'format'
  readonly status: GateStatus;
  readonly violations: readonly Violation[];  // only if 'red' — new, post-baseline
  readonly baselinedCount: number;            // tolerated debt — count only, never payloads
  readonly passCount?: number;                // e.g. "400 tests passed" — a number, never text
  readonly errorMessage?: string;              // only if 'error'
  readonly durationMs: number;
  readonly cacheHits: number;                  // always 0 in v1 (ADR 005) — field exists for the growth path
}
```

- **`error` is categorically distinct from `red`.** `error` means the gate itself couldn't produce a
  verdict — a crashed parser, a missing tool binary, an unreadable config. It is **not** a code problem.
  The orchestrator halts the loop immediately and **escalates to the human** the moment any gate reports
  `error`. Error output **never enters an LLM-facing payload** — sending it would waste tokens on the agent
  "fixing" a problem that doesn't exist in the code.
- **Verdict is `green` only if every gate is `green`.** `skipped` gates do not count against the verdict
  (they were correctly not run — e.g., architecture skipped because parse failed) but a verdict is not
  `green` while any gate is `red` or `error`.
- **v1's only dependency**: `architecture` gate `dependsOn: ['parse']` — parse `red` means nothing about the
  code's shape is reliable, so architecture evaluation is skipped, not attempted against a broken graph.
- **Declared `dependsOn` metadata is the growth contract, not hardcoded pipeline order.** Each gate states
  what it requires rather than the orchestrator hardcoding "types comes before architecture." The plan's
  worked example for the full stack: `types` red → `tests` skipped (would re-report the same compile errors
  as duplicate noise) and `architecture` skipped (violations against code about to be restructured for type
  fixes are wasted tokens) — v1 doesn't have a `types` gate yet, but the orchestrator's skip logic is
  written against `dependsOn` from day one so this activates without an orchestrator rewrite.
- **Text-level always-run carve-out, documented now for the growth stack**: `format`, `lint`, and
  `security.secrets` are declared type-independent and must always run regardless of what upstream gates
  report — a leaked AWS key must never be masked by a type error. v1 has none of these gates, but the
  `dependsOn` model must be expressive enough to declare "always run" (empty `dependsOn`, immune to upstream
  skip cascades) so this carve-out is a config fact when the gate ships, not a special case bolted onto the
  orchestrator later.

## Alternatives considered

- **Hardcoded pipeline order** (`if parseOk then formatCheck() else skip...`). Rejected — the plan
  explicitly names this an anti-pattern; every new gate would require an orchestrator code change instead of
  a metadata declaration, which is exactly the "two fix loops, one redundant" class of risk (new mechanisms
  requiring hand-wiring instead of being generic consumers of the existing contract).
- **Single `pass`/`fail` boolean instead of 4-state `GateStatus`.** Rejected: collapses "the code violates a
  rule" and "the tool couldn't run" into one signal, which is precisely the "environmental tool failure
  misread as code failure" risk in the plan's Key Risks table — an agent cannot safely act on a boolean that
  means two different things.
- **Ship the format/lint/types/security/tests gate contract inert-but-present in v1 code** (stub
  implementations returning `skipped`). Rejected: dead code with no test coverage is worse than a documented
  contract with no code yet — ADR 001 already establishes that tool-wrapping is deferred by evidence, not by
  oversight; stubbing it would blur that distinction.

## Consequences

- v1's `CheckRun.gates` array always has exactly two entries in practice (`parse`, `architecture`) — Stage
  1/3 additions are additive to the array, not a shape change.
- `dependsOn` must be implemented as real metadata (not comments) from v1, even though v1 only exercises one
  edge (`architecture` depends on `parse`) — this is the one piece of "growth contract" plumbing that must
  exist in code now, not just in this ADR, because retrofitting a declarative dependency graph onto a
  hardcoded v1 orchestrator is exactly the rewrite this ADR exists to avoid.

## Evidence

No direct spike measurement (the spike ran two hardcoded rules with no gate stack) — this ADR encodes the
plan's locked gate-model design and generalizes ADR 001's arch-first scope decision into the shared payload
contract every later gate must honor.


## Amendment (2026-07-12): the reference-validity invariant

Three false-green-class defects shared one shape — *a dangling reference evaluating as vacuous truth*: a rule
referencing a renamed/removed component (57a76a2), a component shadowed to zero classified files (3b9e91a),
and a `custom.host` rule naming an unregistered predicate (064edaf). Codified as doctrine:

**Every name an IR rule references — component, layer, host predicate, or any future referent — must resolve
at check time, or the check reports gate `status: 'error'` (never green, never a silent skip).** Resolution
is validated in the orchestrator's pre-evaluation guard step, plugin-independently, so no future language
plugin or rule kind can reintroduce the class. New rule kinds MUST extend the exhaustive reference-validation
switch (the compiler enforces this — see `validateRuleComponentRefs`).

## Amendment (2026-07-13): the sanctioned exception becomes visible, not silent

ADR 003's `empty: 'allow'`/`'until-populated'` (the ADR 003 greenfield-mode amendment, formerly the
boolean `allowEmpty: true`) is this invariant's one deliberate, sanctioned exception: a component that
matches zero files evaluates every rule referencing it vacuously true, by design, for a component that's
legitimately allowed to be empty. That is still correct — the point of the reference-validity invariant
is dangling/unregistered *references*, not intentionally-empty *components* — but `test-apps/
GREENFIELD_TRIAD_REPORT.md` §3 found the exception had no visibility of its own: `verdict: green` reads
identically whether every component is populated and compliant, or every component is empty and the
ruleset is running in vacuous-green mode. That gap is closed (ADR 003 amendment, R1,
`IMPLEMENTATION_PLAN.md` Design Reserve): `CheckRun.ungroundedComponents` — computed by
`findUngroundedComponents` (`components/registry.ts`), threaded through the orchestrator's check-time
guard step alongside the reference-validity checks this amendment already lives next to — names every
component currently relying on the exception, surfaced in `align check`'s human output, `--json`, and the
MCP `align_check` payload. The exception itself is unchanged; what's new is that it can no longer hide
inside an ordinary `green`.
