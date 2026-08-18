# ADR 007: Token-Economy Payloads

**Status**: Accepted

## Context

Every payload align returns to an LLM consumer is a recurring cost paid on every loop iteration, not a
one-time cost — token economy is a plan-wide guiding principle, and the spike gave it hard numbers for the
first time. The spike's initial prose-shaped payload (JSON with a human-readable `message` restating fields
that already existed structurally) measured **182 tokens/violation average**; a structured-fields-only
variant of the *same* three violations measured **51 tokens/violation** (probe 5c) — a **3.6x** reduction,
larger than the plan's original "~2x redundancy" estimate. At uncapped scale this is the difference between
200 violations costing 36.8K tokens (prose) versus 10.2K tokens (structured) — the gap between "fits
comfortably" and "burns a meaningful fraction of a context window" for one tool call.

## Decision

Normative rules for every machine-facing payload (`align_check`, `align_violations`, and `align_check`
previews):

1. **Failures only; passes are counts, never text.** A passing gate contributes `passCount`/`baselinedCount`
   numbers to the payload, never per-item prose. A passing 5-rule check and a passing 400-test suite both
   cost roughly the same handful of tokens.
2. **Structured-fields-only for machine payloads.** No `message` prose field duplicating
   `fromFile`/`toFile`/`specifier`/`line`/component names that already exist as structured fields.
   `fixHint` is a short-code/enum (`docs/core-interfaces.md`), not a prose sentence repeating file:line.
   Human-facing prose is **rendered at the surface** (CLI text renderer, `align_explain_rule`'s dedicated
   prose response) from the same structured fields — never stored twice. Measured: 3.6x reduction, 182→51
   tokens/violation; envelope reduction was even larger, 7.4x (1,402 B → 190 B).
3. **Priority sort before pagination or truncation**: `architecture > security > types > lint > format`
   (v1 payloads only ever populate `architecture`, but the ordering contract is fixed now so later gates
   slot in without reshuffling consumer expectations). Format sorts lowest because it's mechanically
   autofixable and never needs LLM attention directly.
4. **Dedup removes repetition, never targeting data — a normative distinction, not a heuristic.** Collapse
   only *structural* duplicates: one rule, one root cause, many lines (e.g., a file-wide visibility
   violation → a single context block naming all target lines). Discrete errors (type errors, distinct
   unused identifiers) may group under one header to save envelope tokens but **must always preserve
   per-instance identifier, line, and `snippet`** — an LLM cannot construct a search/replace edit block for
   a symbol it was never shown. This is why `Violation.snippet` is a required field, not optional: dedup
   correctness depends on it being present per-instance even when instances are grouped for display.
5. **Caps and pagination are mandatory, not optional.** The spike's first-N-per-rule cap kept a 5-rule red
   response under 900 tokens; at 200 violations uncapped, even the structured-only shape costs 10.2K
   tokens — caps exist regardless of which shape wins.
6. **Per-edge cycle detail is structured, not folded into prose.** A `no-cycles` violation's `chain` field
   is an array of `{from, to, specifier, line}` per hop (`docs/core-interfaces.md`), not a single message
   string naming files — this is rule 2 (structured-fields-only) applied specifically to the one violation
   kind whose "cause" spans multiple files instead of one line, and rule 4 (dedup never removes targeting
   data) applied per-hop rather than per-violation.

## Alternatives considered

- **Keep prose `message` in the machine payload for convenience** (avoid building a surface-side renderer).
  Rejected by the measured 3.6x cost — convenience for the implementer at 3.6x the token cost for every
  consumer on every call is the wrong trade in a system whose stated product thesis is token economy
  (`ARCHITECTURE.md` §1).
- **Dedup that collapses discrete errors into a single count with no per-instance detail** (maximum token
  savings). Rejected: this is the exact failure mode probe 2 flagged as a gap — "the missing `snippet`/
  per-edge-line data cost reads but did not block" the agent; collapsing further would have blocked it
  outright, since it could no longer construct edit blocks for individual instances.
- **No fixed priority order — sort by severity only.** Rejected: severity alone doesn't encode the plan's
  category-precedence doctrine (ADR 012) — architecture violations must surface before lint noise even when
  a lint rule happens to be tagged "error," because the plan treats category as the higher-order signal.

## Consequences

- `docs/core-interfaces.md`'s `Violation` type is structured-fields-only by construction — there is no
  `message: string` field on the base type; a rendering function (`renderViolationMessage(v: Violation):
  string`) lives at the CLI/MCP surface layer, not on the core model.
- `align_explain_rule` remains the dedicated prose surface (320 tokens measured, spike Q6) — prose has a
  home, it's just not inside the terse check/violations payloads.
- Every future gate (format/lint/types/security/tests, Stage 1/3) must honor this ADR's five rules on day
  one — this is a payload-shape contract fixed for the whole gate stack, not an architecture-gate-only rule.

## Evidence

- Probe 5c (spike report): 182 tokens/violation (prose) → 51 tokens/violation (structured-only), **3.6x**;
  envelope 1,402 B → 190 B, **7.4x**; 200-violation projection 36,801 → 10,248 tokens.
- Spike Q6: average serialized violation 729 B ≈ 182 tokens (prose baseline); first-10-per-rule cap kept
  any response under ~10 KB; a 5-rule red `align_check` response measured 897 tokens end to end.
- Probe 2: missing `snippet`/per-edge-line data "cost reads but did not block" the agent — the empirical
  floor for how much per-instance detail dedup must preserve.
