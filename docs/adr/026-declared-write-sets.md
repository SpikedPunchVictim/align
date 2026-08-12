# ADR 026: A Command May Only Touch What It Declares

**Status**: Accepted

## Context

align writes into repositories it does not own. `init` writes `align.config.ts`, `CLAUDE.md`,
`.gitignore`, `package.json` and `.align/**`; `build --apply` rewrites `align.config.ts`'s note
block and three `.align/` artifacts; `baseline prune` deletes consent records; `upgrade` rewrites
selectors inside `align.config.ts`; `skill --install` regenerates a file under `.claude/`. A defect
in any of those is not a wrong answer — it is damage to a developer's working tree.

That is not hypothetical here. **BUG #10** (`.agents/research/2026-08-03-bug-hunt-full-codebase.md:546`)
destroyed a real ruleset. Two runs of `align init` against a config whose note block had lost its
END marker, reproduced verbatim:

```
initial config has rules?   true
after run 1  rules present? true
after run 2  rules present? false   defineProject present? false
```

The file was reduced to an import line plus the note block. Components and rules gone. The same
12-line splice, duplicated into `claude-md.ts`, does the same thing to the human's `CLAUDE.md`
content. It fired from `align init` and `align build --apply` — **not** from `align upgrade`.
BUG #18 (ADR 023) then destroyed baselines from `prune` and `init`, and the 2026-08-11 amendment to
that ADR found `init` doing it a third way. Every one of these was found by a human reading code,
never by a test that failed.

### Why the existing controls do not cover the class

**The unit tests pin instances.** `config-comment.test.ts` now pins all four malformed marker
states as throws. That closes BUG #10. It does nothing about the next splice, in the next writer,
against the next file.

**The integration harness cannot see it.** `captureState`
(`integration/lib/capture.mjs:36-73`) captures a *named allowlist*: five `.align/*` files,
`align.config.ts` whole, and — via `extractClaudeBlock` — **only the region of `CLAUDE.md` between
align's markers**. Everything else in the project tree is invisible to every scenario. A deleted
`package.json`, a mangled `.gitignore`, a stray write into `src/**`, or a corrupted `tsconfig.json`
would pass all 15 scenarios silently. And the human content of `CLAUDE.md` outside the markers —
*precisely what BUG #10 deletes* — is discarded before comparison. **The harness as built would not
have caught the incident that motivates this ADR.**

**Confinement would not have caught it either.** align already dogfoods import-confinement for
`node:child_process` (a `custom.host` predicate plus three portable
`cannotDependOn(external('node:child_process'))` rules), and the analogous rule for `node:fs` is
worth having. But BUG #10 was not an unaudited writer. It was an *authorized* writer running a bad
algorithm. Confinement prevents a new rogue writer appearing; it is silent about a licensed one
corrupting the file it is licensed to touch.

The common shape of all three: **every control requires someone to have anticipated the specific
damage.** Nobody writes the assertion "`align init` must not delete the ruleset from
`align.config.ts`", because nobody expects it to.

## Decision

**Invariant: a command may create, modify, or delete only the paths its scenario declares. Every
other path in the project tree must be byte-identical afterward.**

- **Whole-tree snapshot, not an allowlist.** Each command sequence is bracketed by a snapshot of
  every path under the project root (path → content hash + mode), minus a declared volatile set.
  The assertion is computed on the *delta*, so it covers files nobody thought about — which is the
  entire point.
- **Fail-closed default.** A scenario that declares no write-set gets the empty one: nothing may
  change. Adding a scenario therefore forces its author to state what the command is licensed to
  touch, rather than defaulting to permissive. A control that must be opted into is a control that
  will be forgotten.
- **Content-aware clause for marker-owned files.** `align.config.ts` and `CLAUDE.md` are shared
  with the human. Declaring them writable licenses only the marked block: **the region outside
  align's markers must be byte-identical.** This is BUG #10 expressed as a property rather than as
  a remembered anecdote.
- **Universal, not per-feature.** The invariant is applied to all scenarios by the runner, not
  asserted individually inside them. ADR 023 rejected per-site guarding for the same reason —
  independent guarding is how a defect class reaches five copies.
- **Same invariant in the fast path.** A shared unit-test helper applies the identical check to the
  existing tmpdir fixtures, so it runs on every PR in seconds without Docker. Assertions are nearly
  free; only the *environment* (Docker, dependency installs, pinned checkouts) is expensive. The
  invariant therefore rides every tier, and a cheaper tier costs environment fidelity, never
  destructive-safety coverage.

## Alternatives considered

**Per-scenario assertions on named files** (the status quo). Rejected on the evidence: the harness's
own capture allowlist discards the exact bytes BUG #10 destroys. Anticipation already failed once.

**`node:fs` confinement instead.** Rejected as *coverage for this class* and kept as a separate,
honestly-scoped follow-up: it stops a new unaudited writer, not a licensed writer with a bad splice.
Only 10 files in `packages/cli/src/` perform fs mutation and 10 of ~22 calls already sit in
`align-dir.ts`, so the refactor is tractable — but it must not be sold as covering this ADR's class.

**Scope the harness to `align upgrade`.** Rejected: BUG #10 fired from `init` and `build --apply`,
BUG #18 from `prune` and `init`, and ADR 023's amendment from `init` again. Zero of the three
destructive incidents in this codebase came from `upgrade`. The correct scope is every command that
writes.

**Gate every PR on the full Docker suite.** Still rejected, as in ADR 025 — but the cost is smaller
than that ADR assumed. Measured 2026-08-12: one `nest` scenario end-to-end at `--targets local`
takes **37s** with a warm image, against **26s** for the entire 1104-test unit suite
(build 5s / typecheck 9s / test 12s). "Minutes-long" describes the cross-version matrix, not a
local-target run. The tier boundary belongs on measured numbers, and these are the first.

**Change-scoped test selection** (run only the tests covering a diff). Rejected for the unit suite:
at 12 seconds it would save nothing worth a mapping layer that can silently under-select. If it is
ever built for the harness, it must fail loud on a change it cannot map to a scenario — a run that
skipped tests is an incomplete scan, and ADR 023's thesis is that absent never means verified.

## Consequences

- Every scenario must declare a write-set. New scenarios fail until they do; that is the fail-closed
  default working as intended, not friction to be engineered away.
- A new command or flag is not complete without a scenario (already ADR 025's stated consequence,
  now backed by an invariant that fails rather than by prose that decays).
- Normalization pressure increases. A path that legitimately varies between runs must be *declared
  volatile*, and a declaration that hides a real diff is a defect. Treat every addition to the
  volatile set as a reviewable event, exactly as ADR 025 says of normalization rules.
- `.git/` is excluded from the snapshot, which makes `align agent run` — which commits to a branch —
  a knowing gap. `agent` is already outside harness scope (it needs a live model). Its safety rests
  on claims in its own doc comments; given this repo's record with doc comments asserting safety
  properties, those warrant independent verification.
- The invariant costs approximately nothing at runtime, so there is no tier at which it is worth
  disabling.

## Evidence

- BUG #10 reproduction, verbatim above: `.agents/research/2026-08-03-bug-hunt-full-codebase.md:546`.
- The capture gap: `integration/lib/capture.mjs:36-73` (`ALIGN_DIR_FILES`, `extractClaudeBlock`).
- Existing confinement precedent: `align.config.ts` `hostRules.noChildProcessOutsideGitRails` plus
  the three `cannotDependOn(external('node:child_process'))` rules.
- fs-mutation surface: 22 call sites across 10 files in `packages/cli/src/`, 10 of them already in
  `align-dir.ts` (measured 2026-08-12).
- Timings, measured 2026-08-12 on a warm Docker image: full unit gate 26s; one `nest` scenario at
  `--targets local` 37s.
- Doctrine precedent: ADR 023 ("reports success wrongly" outranks everything; guard the class, not
  the instance), ADR 025 (harness rationale, normalization as load-bearing).
