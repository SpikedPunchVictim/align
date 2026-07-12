# ADR 010: Edit-Block Apply Pipeline

**Status**: Accepted (contract) — **activates at the agent-loop stage (Stage 4)**

## Context

This mechanism belongs to Stage 4 (the built-in BYOK agent loop), which is not part of v1 and does not ship
in Stage 1/2/3. It is specified now, ahead of its implementation stage, for one reason: the `Violation`
model produced by v1's rule evaluators (`snippet`, per-edge cycle detail, `range`) is exactly the data this
pipeline consumes, and getting that data shape wrong in v1 would force a breaking change to `Violation` at
Stage 4. Fixing this contract now means Stage 1–3 build the correct `Violation` shape without re-litigating
it later.

The core problem this pipeline solves: an LLM proposing "search this exact text, replace it with this text"
is reliable at generating the *content* of a fix but unreliable at generating *unambiguous location*
(exact byte offsets, correct ordering across multiple edits in one file) and must never be trusted to do
that arithmetic itself.

## Decision

**`FixProposal` (zod schema)** — search/replace edit blocks, never full files, never line-number diffs
(token economy: a 1-line fix in a 600-line file costs edit-block tokens, not file-sized output; also
eliminates truncation and mid-file hallucination risk):

```ts
const EditBlockSchema = z.object({
  search: z.string(),             // exact, continuous block present in the file, 1–2 lines of
                                   // untouched context above/below for uniqueness
  replace: z.string(),            // empty string = deletion
  nearLine: z.number().optional(),        // disambiguation hint for the engine only — never injected
                                           // into file content
  forViolations: z.array(z.string()).optional(),  // violation ids this edit addresses
});
const FixProposalSchema = z.object({
  files: z.array(z.object({ path: z.string(), edits: z.array(EditBlockSchema).min(1) })).min(1),
  suppressions: z.array(z.object({ ruleId: z.string(), file: z.string(), line: z.number() })).optional(),
  rationale: z.string(),
});
```

**`ValidatedEdit` algorithm** (in core — the LLM proposes, the engine applies; runs against the immutable
original text only):

1. **Scan the immutable original** to find the unique starting byte offset of every `search` block —
   literal character-for-character string matching, no line numbers. Produces
   `ValidatedEdit { startOffset, endOffset, replacement }[]`.
2. **Reject atomically**: any block with 0 or >1 matches, or any two validated spans overlapping → **zero
   edits applied to that file**; the failure feeds back as `FailureContext`. This preserves pure-function
   memoization semantics — a proposal either fully applies or fully doesn't.
3. **Sort validated edits descending by original byte offset and apply sequentially** — edits at the end of
   the file never shift the coordinates of earlier edits. The LLM is never burdened with edit ordering
   (unverifiable, error-prone, and irrelevant to what the fix *is* — ordering only matters at application
   time, which is the engine's job).

**Multi-match disambiguation**: when a `search` block matches more than one location, the engine uses
`nearLine` to pick the closest match instead of rejecting outright — deterministic, and avoids burning a
retry on files with legitimately repeated patterns (JSX, generated code, template-heavy files).

**Match-failure recovery ladder**:
- Retries 1–2: `FailureContext` includes ±3 lines around the nearest candidate region, **with line numbers
  for the LLM's eyes only — never for the engine's search** — so the retry can re-anchor character-for-
  character.
- **Final retry only, DESIGN RESERVE**: a whitespace-normalized fallback, gated by three stacked
  constraints (fail any → no apply, escalate instead): (1) eligibility minimum — ≥3 lines and ≥40
  non-whitespace characters, so short/repetitive blocks can never qualify; (2) locality window — candidates
  bounded to a region around the violation's known `range`; (3) unique within that window. **First
  implementation ships exact-match + `nearLine` only — the whitespace-fallback ladder is not built until
  real retry data from the agent loop shows it's needed** (`IMPLEMENTATION_PLAN.md`, Design Reserve, "likely
  reserve candidates"). Pointer only; full spec lives in the plan's Stage 4 text, not re-litigated here.

**Max-file-size guard**: output cost no longer scales with file size (edit blocks, not full files), but
*input* still does — files over a configurable LOC/byte threshold skip PLAN+FIX and escalate. Threshold
value itself is Design Reserve (needed only once real files hit it).

## Alternatives considered

- **Line-number-based diffs instead of search/replace text blocks.** Rejected: line numbers drift the
  moment any earlier edit in the same file lands, and an LLM computing line-number deltas across multiple
  edits is exactly the kind of arithmetic that should never be trusted to a non-deterministic component.
- **Full-file replacement output.** Rejected: cost scales with file size regardless of fix size, and
  reintroduces truncation/hallucination risk on large files — the plan's stated reason for rejecting it.
- **Ship the whitespace-fallback ladder in the first implementation.** Rejected: no retry-failure data
  exists yet to justify its complexity; exact-match + `nearLine` is the minimum that unblocks Stage 4, and
  the ladder is fully specified as a pre-thought fallback if data later demands it.

## Consequences

- `Violation.snippet` and `Violation.range` (fixed now, `docs/core-interfaces.md`) must be precise enough
  that a Stage 4 `search` block can be constructed from them without additional file reads for the common
  case — this is a v1 data-quality requirement even though the consuming pipeline doesn't exist yet.
- The apply pipeline is entirely engine-side and file-scoped; it introduces no dependency from `@align/core`
  on any LLM client — `FixProposal` is just a zod schema core validates, same as any other IR.

## Evidence

- Probe 2: the agent fixed all 3 violations correctly from tool payloads alone using exactly this
  search-replace-with-context shape informally (via reads/greps); "the missing `snippet`/per-edge-line data
  cost reads but did not block" — validates that precise `snippet`/`range` data is what closes that gap.
- No spike measurement of the apply pipeline itself (Stage 4 not built) — algorithm and fallback-ladder
  design are carried unchanged from `IMPLEMENTATION_PLAN.md`, Stage 4, with the fallback ladder's promotion
  explicitly deferred per the plan's Design Reserve re-audit.
