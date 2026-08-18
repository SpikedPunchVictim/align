# ADR 027: A Nested Git Checkout Is Not Part of This Repo's Architecture

**Status**: Accepted

## Context

align's scan boundary was "every source file under the repo root that no `excludes` pattern
matches." That boundary is wrong whenever a directory below the root is itself a checkout of some
other repository — a `git worktree`, a submodule, a vendored clone. The files are physically
present, so the walk finds them; they are not code this repo's team owns or edits, so every
violation reported against them is noise a user cannot act on.

This is not hypothetical, and align hit it on itself first. Commit `c58e7df` (2026-08-09) added
`'.claude'` to align's own `align.config.ts` `excludes` because Claude Code had placed a full
worktree of this repo at `.claude/worktrees/<id>/`, and a **seeded import-cycle fixture inside that
worktree surfaced as a real `arch.no-cycles` violation of align's own architecture** — a red
`align check` for a reason that had nothing to do with the code.

The interesting part is why the existing controls could not express the fix. `excludes` patterns
are matched by path (exact, directory-prefix, or glob, `isExcludedPath` in
`plugin-typescript/src/scanner.ts`). The repo already excluded
`packages/plugin-typescript/test/fixtures`; a worktree re-introduced the identical fixture tree
under `.claude/worktrees/<id>/packages/plugin-typescript/test/fixtures`, which no pattern matched.
**A path-based exclude cannot pre-name a directory the user has not created yet**, and worktrees
are created on demand, per agent run, with generated names. That commit's own message recorded the
generalization it could not act on: "a nested checkout is never part of the parent repo's
architecture, and any align user running git worktrees inside their repo would hit this."

The signal align was missing is structural rather than nominal: a nested checkout carries **its own
`.git`**. That is one `fs.existsSync` per directory as the walk descends — not a repo-wide search —
and it is true of every case that matters. Note the shape carefully, because it is easy to get
wrong: a clone or submodule has `.git` as a **directory**, while a linked `git worktree` has `.git`
as a **file** containing a `gitdir:` pointer. `hasOwnGit` therefore tests existence, never
`isDirectory()`, and both shapes are pinned by tests
(`plugin-typescript/test/nested-checkout.test.ts`).

## Decision

**Invariant: a directory below the scan root that carries its own `.git` is not part of this
repo's architecture. It is excluded from the scan by default, always named in the run, and opted
back in only by an explicit human declaration.**

- **Auto-exclude, at the walk.** `walkSourceFiles` (`plugin-typescript/src/scanner.ts`) returns
  early on any non-root directory where `hasOwnGit` is true. The scan root itself is exempt
  structurally — `relDir === ''` is checked before `hasOwnGit`, so the exemption does not depend on
  the root happening to have a `.git` at all (align scans a plain directory fine, and every tmpdir
  fixture in the suite proves it). The function's job is finding checkouts *nested below* the root;
  the root is never a candidate.

- **Never silent.** Each skipped path is recorded on `DependencyGraph.skippedNestedCheckouts` and
  carried onto `CheckRun.skippedNestedCheckouts`, and `buildSkippedNestedCheckoutAdvisories`
  (`core/src/gates/advisories.ts`) renders one `nested-checkout-skipped` advisory naming every one
  of them. Silence here would be the false-green shape ADR 003's `empty:` policy and ADR 008's
  reference-validity amendment both exist to prevent: a component whose files all lived under a
  silently-skipped path would evaluate vacuously green with no signal at all. For the sharper
  per-component diagnosis, `components/registry.ts`'s `skippedCheckoutsMatchingSelector` correlates
  a zero-file component with the skipped checkouts its selector would have matched.

- **Structured data, not a parsed message.** The advisory is prose for humans; the array is the
  contract for code. A destructive consumer asking "is this baseline entry's file inside a path
  this scan could not see" reads `CheckRun.skippedNestedCheckouts` directly. Parsing the advisory
  string was considered and rejected as fragile.

- **The opt-out is a config export, matched like an exclude.** `includeNestedCheckouts` in
  `align.config.ts` (`cli/src/config.ts`, threaded through `CheckOptions` →
  `ScanInput.includeNestedCheckouts` → `walkSourceFiles`) re-includes a checkout a human declares
  genuinely part of the project — a submodule the team does edit. It is matched by
  `isExcludedPath`, the same exact-path/directory-prefix/glob dialect `excludes` uses, so a pattern
  means the same thing in both places. Like `excludes`, it is a scan-time concern and deliberately
  **not** part of the portable `RulesetIR`. Opting a checkout back in is not a bypass of everything
  else: ordinary `excludes` still apply inside it (pinned by test).

### `DependencyGraph.skippedNestedCheckouts` is required, and that is deliberate

The field is non-optional. Any out-of-tree `Scanner` implementation stops compiling until it
returns one. That is the intended cost, and this release supplies its own proof that optional would
have been the wrong call.

The same choice was made once as `optional`, in the same feature, and it failed exactly as
predicted. `BaselineStore.prune`/`reconcileMoves` gained a `skippedNestedCheckouts` parameter with a
`= []` default. **One production call site omitted it and silently got pre-fix behaviour with no
type error**: `runSecurityGate` in `core/src/orchestrator.ts` called
`this.baselineStore.reconcileMoves(allViolations, knownFiles)` — visible in the diff of commit
`9d9c9a9`, which made the parameter required on the interface and changed that call to pass `[]`
explicitly. A caller with genuinely nothing to pass now says so, which is a reviewable decision
rather than an invisible default.

(The concrete class keeps a `= []` default on its own methods so the 10 two-argument calls in
`core/test/baseline.test.ts` still compile; the interface is what production code holds. The
residual — a caller holding the concrete class could still omit it — is stated in the source and
was checked: both `.prune(...)` call sites, `commands/baseline.ts` and `commands/upgrade.ts`, pass
the paths explicitly.)

Optionality on a safety-relevant parameter buys back-compatibility by making the unsafe path the
default one. A required field converts a silent behavioural regression into a compile error, and a
compile error is the cheapest possible place to find this.

### Prune retention: skip and report, do not refuse

A baseline entry whose file lives inside a skipped checkout looks **orphaned** to
`store.prune` — its violation is absent from the run — for a reason that has nothing to do with the
violation being fixed. That is BUG #18's shape (ADR 023) reached by a new route.

ADR 023's tier-2 guard does not cover it. `isRunComplete` fires only on a `missing-dependencies`
advisory, so a scan that skipped a checkout is still `complete: true`. The decided fix is
**skip-and-report**:

- Every entry a destructive write would drop is partitioned by
  `partitionSkippedCheckoutCandidates` (`cli/src/nested-checkout-retention.ts`) into **retained**
  (file at or under a skipped checkout — carried forward into what gets persisted, never deleted)
  and **forfeited** (everything else — dropped exactly as before).
- The command **still exits 0** and still prunes everything genuinely fixed. `describeRetainedEntries`
  prints one line naming the count and only the checkout paths that actually own a retained entry.
- ADR 023's `refuseIfRunIncomplete` is evaluated against the **forfeited** count only: a retained
  entry was never at risk once retention put it back.
- Applied at both destructive consumers — `baselinePrune` (`commands/baseline.ts`) and both of
  `runInit`'s write paths, through the single helper
  `partitionAndRefuseIfBaselineWriteAtRisk` (`commands/init.ts`). One shared module for the
  containment test, per ADR 023's "guard the class, not the instance."

**Why this differs from ADR 023's all-or-nothing refusal, which remains correct there.** An
incomplete scan says "some dependency somewhere is missing" — the taint is unlocated, so *any*
absent violation might be unobservable, and only a whole-run refusal is honest. A skipped checkout
**names its own paths precisely**. We know exactly which entries are affected and exactly which are
not. Refusing the whole prune would block a user from clearing genuinely-fixed debt anywhere in the
repo because of an unrelated vendored directory, and a rule users cannot satisfy is a rule they
route around (ADR 023's own reasoning for why tier 2 has an override at all). Deleting them was
never on the table: it is the silent-data-loss shape this project treats as severity zero.

## Alternatives considered

**Warn about a nested checkout and keep scanning it.** Rejected. The user still gets a red
`align check` listing violations in code their team does not own or edit, and the only remediation
is the `excludes` pattern that provably cannot be written in advance. The warning would restate a
problem it does not solve.

**Keep using `excludes` and document the pattern.** Rejected on the evidence above: align's own
config could not express it. Worktree directory names are generated per agent run, and a
prefix-anchored pattern cannot pre-name a directory that does not exist yet.

**Detect a checkout by name (`vendor/`, `third_party/`, `.claude/worktrees/`).** Rejected: a
convention heuristic is wrong in both directions, while `.git` is the thing that actually makes a
directory a separate repository.

**Make `skippedNestedCheckouts` an optional field / optional parameter.** Rejected, with this
release's own counter-example: the optional version of the identical parameter on `BaselineStore`
let a production call site silently keep pre-fix behaviour. Recorded above.

**Model a skipped checkout as another `UncertaintyReason`.** Rejected: `uncertain` markers are
per-specifier; these are whole skipped subtrees. Folding them in would make a scan-scope fact
invisible among hundreds of unresolved-import markers.

**Treat a skipped checkout as `complete: false` and reuse ADR 023 tier 2 unchanged.** Rejected: it
would refuse the whole prune (and, transitively, `init` and `upgrade`'s prune half) over a hazard
whose blast radius is known exactly. Precision was available; discarding it would trade a real,
everyday capability for no additional safety.

**Delete the retained entries and report that we did.** Rejected outright — deletion of a consent
record is irreversible, and "did something destructive, said so, exited 0" is a description of BUG
#18, not a mitigation of it.

## Consequences

- **A default changed.** Before this release, a nested checkout's files were scanned and could
  produce violations, baseline entries, and graph edges. They are not scanned now. A user sees the
  violation count drop, sees a `nested-checkout-skipped` advisory naming the paths, and — if a
  submodule really is part of their project — must add it to `includeNestedCheckouts` to get the
  old behaviour back. This is a behaviour change users will notice, and it is the point.
- **Any out-of-tree `Scanner` implementation stops compiling** until it returns
  `skippedNestedCheckouts`. `DependencyGraph` is part of core's published surface, so this is a
  genuine API break, taken knowingly for the reason recorded above.
- `align baseline prune` and `align init` can now leave entries behind that a user expected to be
  cleared, and say so. `align upgrade`'s prune preview repeats `baselinePrune`'s post-retention
  derivation exactly, so the consent prompt and the guard agree with what the command will do
  (commit `9d9c9a9`; before it, the preview counted `store.prune`'s raw `removed.length` and
  over-counted by exactly the retained entries).
- The security gate performs no nested-checkout exclusion and passes `[]` explicitly. That
  exemption is pinned by a manifest-scanner test rather than asserted in a comment.

### The F1 consequence: a scan-scope change is not local to scanning

This is the part worth carrying forward, and it was not anticipated when the feature was designed.

Auto-exclusion removes a file from the scan's `knownFiles` **the same way a genuine rename does**.
`InMemoryBaselineStore.applyMoves` reads that absence as its move-rescue signal: FRAGILE #7 had
already established that "moved" must mean *the orphan's own file is gone from this scan*, and a
skipped checkout satisfies that test perfectly while meaning something entirely different. The
rescue path then searched for a live violation sharing the orphan's content fingerprint — same
`ruleId`, identical trimmed source line — which is **the expected case for a vendored copy of the
same code**, not an exotic collision. On a match it transferred the baseline entry, stamping a
real human's `acceptedAt`/`acceptedBy` onto a violation nobody had ever reviewed.

The prune retention above does not catch this. Retention partitions `PruneResult.removed`; a forged
transfer lands in `moved` and never reaches the partition at all.

Reachability is the severe part. `orchestrator.check` calls `reconcileMoves` on **every**
invocation, and `commands/check.ts`'s `persistMovedBaseline` writes the result unconditionally. So
this fires on a plain `align check` — no destructive command, no flag, and no completeness gate
anywhere in the path. Reproduced against a fixture with one real, never-accepted
`arch.no-dependency` violation and one baseline entry pointing into a skipped checkout with a
colliding content fingerprint (re-run 2026-08-13 by removing the guard from `applyMoves` and
rebuilding):

```
  advisory (baseline-moved): 1 entry transferred (file moves).

baselined debt: 1 → 1 (0)
verdict: green
check exit: 0
```

A live violation pre-accepted with forged provenance, a green verdict, exit 0 — the project's
severity-zero class, "reports success wrongly." **It was found by adversarial review, not by a
test**, which is the fourth time in this codebase's short history that a safety defect was found by
a human reading code.

The fix routes a file under `skippedNestedCheckouts` to the same branch as a file still in
`knownFiles`: `applyMoves` treats it as "still known," so it goes to `unmatchedOrphans` — precisely
the arm prune retention already protects — and is never offered for a content match. The
containment test lives once, in `core/src/baseline/skipped-checkouts.ts`, imported by both
`store.ts` and the CLI's retention module.

**The reviewable lesson: changing what a scan sees is never local to scanning.** Other subsystems
infer meaning from absence — `applyMoves` infers "renamed", `store.prune` infers "fixed",
`validateComponents` infers "empty component". Narrowing the scan silently changes what each of
those infers. A future change to scan scope (a new default exclude, a new skip rule, a
performance-motivated cap) must enumerate the consumers of absence before it ships, not after
review finds one.

### Amendment (2026-08-18): that enumeration was done, and the answer was worse than this ADR assumed

[ADR 028](028-2026-08-16-scan-blind-spots-and-the-absence-inference.md) is the result of running the
paragraph above in the other direction — not "what breaks when we narrow the scan" but "in how many
ways is the scan already narrower than the repository, and what does each one do to a consent
record." **A nested checkout was one of six**, and this ADR's fix — record the skipped paths on the
run, route them to the "still known" branch — turns out to be the right shape applied too narrowly.
The other five (an `excludes` match, an always-excluded directory name, an unreadable directory, an
unparseable manifest, a symlinked subtree) reach `applyMoves` by exactly the path F1 took, and three
of them were unknown when this ADR was written.

Two consequences for a reader of this ADR:

- **`DependencyGraph.skippedNestedCheckouts` is gone**, generalized into `blindSpots` with a
  `ScanBlindSpotReason` union whose `nested-checkout` variant is this ADR's case. The containment
  test moved with it, from `core/src/baseline/skipped-checkouts.ts` to
  `core/src/baseline/scan-blind-spots.ts`, and is still imported by both consumers rather than
  restated — the property this ADR argued for, at the wider scope.
- **The lesson generalizes past scanning.** F1 was reproduced again on 2026-08-17 and 2026-08-18 in
  two forms this ADR's guard does not cover: a whole directory absent from the working tree (LEDGER
  D010) and a file-level transfer needing no blind spot at all (LEDGER D015, still open). The stable
  statement is therefore stronger than "a scan-scope change is not local to scanning": **absence
  from a scan is not evidence of deletion, whatever produced the absence** — and separating a rename
  from a deletion-plus-coincidence is not decidable from a single snapshot at all, which is what
  [ADR 029](029-2026-08-18-scan-observation-history.md) exists to fix.

## Evidence

- The motivating incident, verbatim from `c58e7df`'s message (2026-08-09): a Claude Code worktree
  at `.claude/worktrees/<id>/` re-introduced a seeded cycle fixture under a path the
  prefix-anchored fixture excludes could not match, turning align's own `align check` red.
- Detection shape, both variants pinned: `plugin-typescript/test/nested-checkout.test.ts` covers
  `.git`-as-directory (clone/submodule), `.git`-as-file (linked worktree), the root's structural
  exemption, sorted reporting, the `includeNestedCheckouts` opt-out, and that the opt-out does not
  bypass ordinary `excludes`.
- The optional-parameter failure: commit `9d9c9a9`'s diff of `core/src/orchestrator.ts` shows
  `reconcileMoves(allViolations, knownFiles)` — the two-argument production call — becoming the
  explicit three-argument form.
- F1 reproduction: `cli/test/nested-checkout-scan-scope.test.ts`'s
  "`align check` (the unguarded reconcileMoves path…)" case. Re-verified 2026-08-13 by removing
  `isUnderSkippedCheckout` from `applyMoves`'s guard and rebuilding — output above.
- Related: ADR 023 (refusal tiers, and why this hazard needed a different answer), ADR 006
  (baseline consent, move-transfer), ADR 003 (`empty:` policy), ADR 008 (gate model,
  reference validity), ADR 004 (scan-and-discard walk).
