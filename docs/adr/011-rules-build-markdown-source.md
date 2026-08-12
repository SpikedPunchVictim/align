# ADR 011: Rules-Build Markdown Source

**Status**: Accepted (contract) — **activates at its stage (Stage 4, `align build`)**

## Context

This mechanism is not part of v1 — v1 rulesets are authored directly via the DSL (ADR 002). It's specified
now because the IR's provenance metadata (`sourceFile`, `sourceLineRange`, `sourceQuote`) has to exist in
the `RuleIR`/`RulesetIR` shape from the start (ADR 002, `docs/ir-schema.md`) for `align build` to slot in
later without an IR migration. Getting the provenance field shape wrong in v1 would break every rule
produced by `align build` at Stage 4.

The core idea: an architecture/best-practices markdown doc is a **buildable intent source**, compiling to
the ruleset the way `package.json` resolves to a lockfile — the artifact is JSON IR with provenance, not
generated TypeScript, so nothing machine-written lives inside a human-edited file, and violation output can
quote the doc's own English.

## Decision

- **Lockfile pattern**: `.align/rules.lock.json` (section hashes ↔ rule ids) + `.align/generated-rules.json`
  (IR with per-rule `sourceFile`/`sourceLineRange`/`sourceQuote` provenance), imported by `align.config.ts`.
  Nothing machine-written lives inside a human-edited file.
- **Precision ladder** for doc authoring, in order of trust (zero-LLM first):
  1. Fenced ` ```align ` blocks compile **verbatim** — zero LLM involved.
  2. Structured `- **Rule**:` bullets parse **deterministically**; an LLM only grounds fuzzy selectors
     against the components registry (never invents rule structure).
  3. Free prose goes through **two-pass clarification** (below) — the least-trusted, most-scaffolded path.
- **Two-pass Clarification Mode**: pass 1 (**Discovery**) — the LLM reads the doc and outputs a short list
  of *concerns* ("layer isolation," "module size"), no IR yet; a human confirms or skips each. Pass 2
  (**Refinement**) — IR is generated only for confirmed concerns, each selector grounded against component
  names (never raw paths, ADR 003) with a dry-run report before anything is written. This prevents the
  overwhelm of a 20-unsolicited-rule dump; ambiguous statements ("the system should be modular") become
  concerns for a human to interpret, not hallucinated rules.
- **Build gates**: default is **dry-run with an impact delta** ("adds N new violations / masks M
  baselined"); nothing writes without `--apply`, which also emits a human-reviewable audit map
  (`.align/last-build-report.md`: rule ↔ source sentence ↔ IR ↔ dry-run impact). New violations require
  explicit baseline-as-debt consent, mirroring `align init` (ADR 006).
- **Rule-level diff minimization**: re-proposals are diffed against existing rules; IR-identical rules keep
  their ids verbatim, so a prose typo fix that re-proposes a section yields an **empty diff**.
- **`--frozen-rules` CI mode** (≡ `align check --frozen-rules`): doc section hashes ≠ lockfile → red.
  Two-way drift: doc changed but rules not rebuilt → `doc-drift` advisory; generated artifact hand-edited →
  `divergence` advisory.

## Alternatives considered

- **Regenerate the full ruleset from the doc on every build, no diff minimization.** Rejected: a one-word
  typo fix in the doc would churn every downstream rule id, breaking baseline continuity (ADR 006's
  fingerprints are rule-scoped) for no substantive rule change.
- **Single-pass LLM extraction (concerns + IR in one call).** Rejected: this is exactly the
  "rule-proposal overwhelm" risk in the plan's Key Risks table — a single pass over a real architecture doc
  tends to produce many more rules than a human would confirm wanting; splitting discovery from refinement
  puts a human confirmation gate between "the LLM noticed something" and "a rule gets written."
  Rejected. **Generated TypeScript instead of JSON IR with provenance** — rejected per ADR 002's locked
  decision: JSON IR is the portable substrate; generated TS would need parsing wherever consumed.
- **No `--frozen-rules` CI mode.** Rejected: without it, a doc edit can silently change CI's enforced
  ruleset with no gate — the "a doc edit silently blows up CI with new rules" risk in the plan's table.

## Consequences

- `RuleProvenance` (ADR 002, `docs/ir-schema.md`) must carry `sourceFile`/`sourceLineRange`/`sourceQuote` as
  optional fields from v1's first IR version — DSL-authored rules simply leave them undefined; doc-built
  rules populate them. No schema version bump needed at Stage 4.
- `.because()` (ADR 002) and `sourceQuote` converge on the same terminal-output field — a doc-built rule's
  `.because()`-equivalent text is auto-populated from `sourceQuote`, not duplicated.
- Prompt templates and doc parsers stay a lazily-imported module — LLM dependencies are optional at runtime,
  and the MCP path (`align_propose_rules`) never requires an API key, since the connected agent supplies the
  judgment and align supplies validation.

## Evidence

No spike measurement — `align build` is entirely Stage 4, not exercised by Stage S. This ADR carries the
plan's design (locked-decision text and Stage 4 goal section) forward unchanged, fixing only the IR
provenance contract now so v1's schema doesn't need to migrate later. Design Reserve items (doc frontmatter
versioning, `--fallback-manual`) are pointers to `IMPLEMENTATION_PLAN.md` only — not respecified here.

## Amendment (2026-08-12): the generated-rules hash is reproducible

**The defect.** `writeBuildArtifacts` (`packages/cli/src/commands/build.ts:271`) writes
`.align/generated-rules.json` with `generatedAt: Date.now()`, then computed
`generatedRulesContentHash = sha256Hex(rawWritten)` — a hash of the whole file's raw bytes,
`generatedAt` included. Two builds producing byte-identical rules therefore hashed differently
whenever the wall clock had moved between them, which is every real invocation. This wasn't a live
bug — `verifyFrozenRules` only ever compares the stored hash against the current file, and both move
together on every write — but it silently broke "rebuild and compare," the property `--frozen-rules`
exists to make trustworthy: nobody could verify a generated ruleset was unchanged without also
asking whether it had been built in the same millisecond.

**The fix.** The hash input is now an explicitly reconstructed `{ irVersion, docPath, rules }`, in
that fixed key order, built from the parsed file — not the raw bytes
(`reproducibleGeneratedRulesHash`, `commands/build.ts`). `generatedAt` stays in the file: it is
human-facing provenance (when this was built), written and schema-validated, but confirmed to be
read by no code path in either package — so dropping it from the hash costs nothing but the false
precision it was adding. An edit that changes enforcement (a different rule, selector, or scope)
still changes the reconstructed object and is still detected; a rebuild that changes only the
timestamp no longer is — that narrowing is the entire point of the fix, not a side effect to guard
against.

**The transition.** Every `rules.lock.json` written before this change stored the old, raw-bytes
hash. Comparing it against the new reproducible hash unconditionally would report every one of
those lockfiles as `.align/generated-rules.json`'s having "been hand-edited or removed" — a false
tampering accusation against a repo that changed nothing, which ADR 006's silence-is-never-consent
doctrine argues against just as strongly as it argues against silent acceptance: an accusatory
false positive is not an acceptable failure mode either. `checkGeneratedRulesDivergence`
(`commands/build.ts`) therefore falls back to the legacy raw-bytes comparison on a mismatch; a
legacy-hash match reports a distinct `lockfile-predates-reproducible-hash` advisory instead of
`divergence`, telling the user to re-run `align build --apply` rather than accusing them of an edit
that didn't happen. Only when neither hash matches is it reported as real divergence. The fallback
is marked `TEMPORARY` in its doc comment and may be deleted, collapsing both failure branches back
into one, once no supported `rules.lock.json` can still predate this change — no sooner than the
release after 0.2.0 (the version this amendment ships in), and only once upgrade paths have had a
chance to rebuild.

**Also fixed**: a doc comment on `readGeneratedRulesRaw` (`packages/cli/src/align-dir.ts:213`, prior
to this amendment) asserted "content-hash it verbatim for divergence detection" — describing exactly
the raw-bytes behavior this amendment replaces. A doc comment asserting a property the code doesn't
implement is this repo's most-repeated defect class (`CLAUDE.md`'s destructive-safety rule 5); this
one is corrected to describe what the raw bytes are actually used for now: `.parse()`, and,
temporarily, the legacy fallback comparison above.
