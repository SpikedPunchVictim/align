# ADR 028 — scan blind spots: staged plan

Transient. Delete this file when every stage is Complete. The permanent record is
[`docs/adr/028-2026-08-16-scan-blind-spots-and-the-absence-inference.md`](docs/adr/028-2026-08-16-scan-blind-spots-and-the-absence-inference.md);
`IMPLEMENTATION_PLAN.md` is the long-lived rules track and is **not** to be edited for this work.

**Scope decision (2026-08-16):** the middle option. Blind-spot record, existence probe, and the
`knownFiles()`/double-scan collapse ship in **0.2.0**. The pipeline reframe (ADR 028 §7) is decided
in principle and deferred to a later release with its own ADR.

**Gate for every stage** — no stage is Complete until all four are green:

```
pnpm build && pnpm typecheck && pnpm test      # fast gate, run always
node packages/cli/dist/index.js check          # red is blocking
node packages/cli/dist/index.js doctor         # advisory only, always exits 0
node integration/run.mjs --targets local       # Docker
```

Release gate, once at the end: `node integration/run.mjs --targets 0.1.4,local` — three scenarios
carry `expectFailOn: ['0.1.4']` as calibration; if those pass against 0.1.4 the harness is broken and
nothing it reports can be trusted.

**Three decisions made while defining the work** (they were latent gaps in the first draft):

1. **The run carries the observed file set, not just the blind spots.** Stage 3 cannot delete
   `orchestrator.knownFiles()` unless `CheckRun` already carries what that method returns. So Stage 1
   adds *both* — per-domain observed files and blind spots — and Stage 3 becomes a pure deletion.
2. **The two scan domains stay separate on the run.** `CheckRun` carries source and manifest
   domains distinctly. `knownFiles()` merges them today (orchestrator.ts:252-259) while `check` keeps
   them per-gate; the merge is the bug, not the interface.
3. **The migration validator stays checkout-specific.** `migrations/validators/baseline-entries-in-skipped-checkouts.ts`
   is wired into the 0.2.0 registry entry (registry.ts:64) with its own `UPGRADING.md` note. It exists
   because 0.2.0 *changed* scan scope for checkouts. Symlink and exclude blindness are not new in
   0.2.0 — they are standing bugs — so widening this validator would misreport them as migration
   consequences. Re-point it onto the generalized helper; do **not** widen its scope.

---

## Stage 1: The walk records what it could not see

**Goal**: `walkSourceFiles` returns blind spots with reasons; `DependencyGraph` and `CheckRun` carry
them **and** the observed file set, per domain; `skippedNestedCheckouts` is gone.

**Work** — 29 files. Ordered so the tree compiles at each step.

*Types first*
- `core/src/types/graph.ts:106` — replace `skippedNestedCheckouts` with `blindSpots: readonly ScanBlindSpot[]`;
  define `ScanBlindSpot` / `ScanBlindSpotReason` (variants: `nested-checkout`, `excluded{pattern}`,
  `default-excluded-dir{name}`, `unreadable{error}`, `not-regular-file`). Required, not optional.
- `core/src/gates/types.ts:48-61` — same on `CheckRun`, **plus** the observed file sets:
  source and manifest kept separate (decision 2).

*Producer*
- `plugin-typescript/src/scanner.ts:199-241` — `walkSourceFiles` collects blind spots at each of the
  five exits (`:208` excluded dir, `:215` checkout, `:224` unreadable, `:228` default-excluded,
  `:233` excluded file) plus the new `not-regular-file` case at `:227/:231`.
- Move the `DEFAULT_EXCLUDED_DIR_NAMES` test **before** the `isDirectory()/isFile()` branch, so a
  symlinked `node_modules`/`dist` classifies as `default-excluded-dir` rather than
  `not-regular-file`. Checked this repo: its `node_modules` directories are real, so this is not the
  universal case an earlier draft claimed — but it occurs in generated and container layouts and the
  fix is free.
- `scanner.ts:118,161-169` — thread through `scan()` onto the returned graph.

*Containment helper*
- `core/src/baseline/skipped-checkouts.ts` → generalize to at-or-under matching over blind-spot
  paths. Still **one** containment test in one module (ADR 027's rule). Keep
  `isUnderSkippedCheckout` as a narrow wrapper for the migration validator (decision 3).

*Consumers — src*
- `core/src/orchestrator.ts` — `:96,151,182` (error-path graph literals), `:146,177,219` (advisory
  building), `:193-198` (the `reconcileMoves` call), `:238` (CheckRun assembly), `:306-314` (manifest
  domain, still passes its own — **not** merged), `:364-371` (multi-graph union: union blind spots
  the same way).
- `core/src/baseline/store.ts:43-85,168-232` — signature and the `applyMoves` guard at `:232`.
- `core/src/gates/advisories.ts:111` — advisory now names reasons; dedupe paths and cap with
  `+N more`, matching `describeUnverifiablePrunes`.
- `core/src/payload/builder.ts:44-48,105` — wire-format field. **Verified not a break** (2026-08-16):
  `git show v0.1.4:packages/core/src/payload/builder.ts` has zero occurrences — the field was added
  in `b38a56f` for unreleased task #25, so no published version emits it. The four MCP `registerTool`
  calls declare no `outputSchema` (results are free-form text, `server.ts:90`), nothing in-repo reads
  `payload.skippedNestedCheckouts`, and `UPGRADING.md` names only the advisory. **Do it in this
  stage**: `CheckPayload` is unversioned (`irVersion: '1'` is the ruleset IR, a different artifact),
  so this is the last release in which the rename is free.
- `core/src/components/registry.ts` — `skippedCheckoutsMatchingSelector` generalizes: a component
  whose files all sit under *any* blind spot gets the sharper diagnosis, not just checkouts.
- `cli/src/nested-checkout-retention.ts` — `partitionSkippedCheckoutCandidates` generalizes;
  `describeRetainedEntries` states the reason.
- `cli/src/commands/baseline.ts:158`, `init.ts:102`, `upgrade.ts:262,342`, `doctor.ts` — call sites.
- `cli/src/migrations/validators/baseline-entries-in-skipped-checkouts.ts` — re-point onto the
  generalized helper, scope unchanged (decision 3).

*Tests — re-point, never delete*
- `core/test/`: `helpers.ts:81,90`, `baseline.test.ts`, `orchestrator.test.ts:496`,
  `payload-builder.test.ts:46`, `gates/advisories.test.ts:243`, `surface/inferSurface.test.ts:29`
- `cli/test/`: `baseline-debt.test.ts`, `errored-run-mutations.test.ts`, `nested-checkout-scan-scope.test.ts`
- `plugin-typescript/test/`: `nested-checkout.test.ts`, `manifest.test.ts`
- `agent/test/`: `helpers.ts`, `fakeEffects.ts`, `e2e-git.test.ts` — the agent package builds graphs
  too; it was missing from the first draft entirely.

**Success Criteria**
- `skippedNestedCheckouts` appears nowhere outside the migration validator's narrow wrapper. A
  transient overlap during the stage is fine; shipping two records is not, and removal is a
  criterion of *this* stage.
- Blind-spot volume is bounded: an excluded or default-excluded directory is recorded once and never
  descended into, so `node_modules` contributes one record, not thousands.

**Tests**
- Scanner unit, one per reason: symlinked file, symlinked directory (subtree absent, **one** record),
  broken symlink, `chmod 000` directory, `excludes`-matched file, `excludes`-matched directory,
  `DEFAULT_EXCLUDED_DIR_NAMES` hit, nested checkout.
- Symlinked `node_modules` → `default-excluded-dir`, not `not-regular-file` (pins the ordering fix).
- `node_modules` contributes exactly one blind spot (pins the volume bound).
- Table-driven exhaustiveness keyed by the reason union: adding a variant without a retention
  decision fails the build or the test.
- Every existing checkout test passes under the new field, equivalent-or-stronger.

**Status**: Complete (2026-08-16, commits `e042520` / `443ea2a` / `19bf230`)

Measured at completion: typecheck 0 errors, **1229 passing + 1 skipped** (from 1203+1 at `f0b48c7`),
`align check` green with 29 baselined and output byte-identical to baseline, `align doctor` exit 0,
`node integration/run.mjs --targets local` 15/15 PASS, whole fast gate 24.4s.

Four defects were found while building this stage, all fixed here — recorded because each is a
shape worth recognising again:

1. **The volume bound did not hold for `excludes`.** `excludes: ['generated/**']` does not match the
   directory `generated`, so the walk descended and recorded one blind spot PER FILE. Fixed by
   stopping the walk at a directory whose subtree a trailing `/**` already excludes — this narrows
   what the walk WALKS, never what it includes, pinned by a partial-subtree test.
2. **A blind spot at the repo root protected nothing.** An unreadable scan root records path `''`,
   and at-or-under matching answered false for every file — so the one case where align sees nothing
   was the case where `prune` would empty the baseline at exit 0.
3. **The `/**` test ran on the raw pattern**, so a `/**` inside a brace group (`src/{a/**,b/**}`)
   never bounded the record: 10 spots against 2 for the equivalent un-braced form. Now expanded
   through core's own `expandBraces`.
4. **`validateComponents`' likely-cause message was uncapped** — a selector with no literal anchor
   matches every blind spot, so one component's error could carry ~200 paths as prose.

**One decision taken that this plan did not specify.** The record is complete; the advisory is not.
Measured on this repo: 200 blind spots, 143 of them `default-excluded-dir`. `check` reports only the
three kinds a user cannot predict from their own config (checkout, unreadable, symlink);
`excluded`/`default-excluded-dir` are recorded but not advised, so retention still protects entries
under them and `prune`/`init` still print the reason when an entry is actually retained. Reviewed
and upheld. Consequence to expect: `align check`'s output on a clean repo is unchanged.

**Out-of-stage work this forced, done in `443ea2a`.** No package typechecked its tests
(`"include": ["src"]`), which quietly undercut ADR 027/028's whole argument for REQUIRED fields —
in test code a silent regression never became a compile error. Twelve fixtures built `CheckRun`s
with no `blindSpots` and passed. Each package now has a `tsconfig.test.json`; the 103 errors that
surfaced were all real, including two `components-registry` tests that passed for the wrong reason
and an `agent` helper silently discarding path normalisation at runtime.

**Reported, deliberately not fixed:** `packages/core/src/build/` (`diff.ts`, `export-ir.ts`,
`ground.ts`, `hash.ts`, `impact.ts`) is not scanned by align at all — `build` is in
`DEFAULT_EXCLUDED_DIR_NAMES`. Pre-existing (confirmed against `HEAD~`), and it survives
`validateComponents` because that check is per-component and needs only one match — ADR 028 §6's
exact argument, occurring in align's own tree.

---

## Stage 2: Existence probe, and the guard on both destructive arms

**Goal**: an orphan whose file is absent from the scan is retained when the filesystem still has it,
whatever the cause — closing the tail Stage 1 cannot enumerate.

**Work**
- Define `FileExistenceProbe` (`(file: RepoRelativePath) => boolean`) in core's types. **`packages/core`
  imports `node:fs` nowhere** — verified, zero matches under `core/src`, and it stays that way.
- `core/src/baseline/store.ts` — `InMemoryBaselineStore` takes the probe as a constructor
  collaborator; guard both arms: the `applyMoves` transfer path (`:193-232` — the forged-consent arm,
  reached on every `align check`) and the prune forfeit partition (`:183`).
- **Seven construction sites**, each needs a probe — this was the gap in the first draft, which
  assumed only the composition root:
  `cli/src/composition-root.ts:28`, `cli/src/commands/baseline.ts:51,135,211`,
  `cli/src/commands/upgrade.ts:337` (the preview store), `cli/src/commands/build.ts:285`.
- CLI supplies one real `fs`-backed probe from a single module (not six inline closures); core tests
  supply a fake.
- `core/src/orchestrator.ts:198,314` — pass-through unchanged in shape.

**Success Criteria**
- Retention is reported with its reason, never silent (ADR 028 §3).
- ADR 023's `refuseIfRunIncomplete` evaluated against the forfeited count only.
- A retained entry is carried into what gets persisted — assert byte-level, not just count.
- Grep proving core is still filesystem-free is part of the stage, not an assumption.

**Tests**
- Both arms × both mechanisms: blind-spot-recorded cause, and probe-positive-but-unrecorded cause
  (a file present on disk, absent from the scan, with no matching blind spot — the unknown-future-cause).
- `chmod 000` directory: pins that the probe **alone** fails here (`existsSync` swallows `EACCES`)
  and Stage 1's record is what saves it. This is the test that justifies both mechanisms existing.
- Broken symlink → correctly gone, still prunes.
- Genuine deletion → still prunes; genuine rename → still transfers. No over-retention regression.
- Core tests construct the probe without touching a filesystem.

**Status**: Complete (2026-08-17, commits `97c1e45` / `d1ba7ce` / `e8b19d9`, plus `6fa7f02` for F3)

Measured at completion: typecheck 0 errors, **1256 passing + 1 skipped**, `align check` green with
29 baselined, `align doctor` exit 0, `--targets local` 15/15 PASS.

**The probe is REQUIRED with no default.** There is no safe default — `() => false` silently
restores pre-ADR-028 behaviour at any site that forgets it (ADR 027's counter-example), `() => true`
makes `prune` a permanent no-op. 6 production and 59 test sites state their answer; the compiler
enumerated all of them because `443ea2a` had just made tests typechecked.

**Retention stayed in the CLI helper, not core.** `init`'s destructive path never calls
`store.prune`, so a store-only guard would have protected `prune` and missed both of init's write
paths — the fix-one-arm shape ADR 027's F1 was.

Four defects, two found by this stage's own tests and two by review:

1. **Over-retention, the opposite severity-zero.** The probe was applied without ADR 028's "absent
   from the scan" precondition. Every scanned file also exists on disk, so it retained every
   genuinely-fixed violation — `prune` becomes a permanent no-op and the baseline can only grow.
2. The retention message rendered an **empty cause list** for a probe-retained entry, which by
   construction has no covering blind spot. The split now carries its reason.
3. **`fs.existsSync` is case-insensitive** on macOS/Windows, so a case-only rename read as "still
   present": move-transfer suppressed, `align check` RED on a pure rename (violating ADR 006), entry
   retained forever. That falsified two of ADR 028's own claims. The probe now compares parent
   directory entry names — case-exact everywhere, and a developer's Mac now agrees with Linux CI
   about a shared committed baseline. Measured before/after: `moves=0` -> `moves=1`.
4. A `..` in a hand-edited baseline **probed outside the repo**. Now containment-guarded.

**F3, from the Stage 2 review, closed in `6fa7f02`** — the second walker had the same disease. A
`package.json` behind an unreadable directory was on disk, unobserved, covered by no blind spot, and
read absent to the probe, so it reached the content match — where manifest collisions are the NORM,
since the snippet is the dependency line itself. Three exits now recorded (`unreadable`, a new
`unparseable` variant for corrupt-!=-absent, and `excluded`), plus the identical
`existsSync`-hides-`EACCES` bug in `loadWorkspacePackages`. Measured on the reproduction:
observed=false, probe=false, **covered-by-blind-spot=true**.

---

## Stage 3: Delete `orchestrator.knownFiles()`; `prune` scans once

**Goal**: remove the method whose own doc comment apologises for it, and the second walk it serves.
Pure deletion, because Stage 1 already put the observed file set on the run.

**Work**
- `core/src/orchestrator.ts:252-259` — delete `knownFiles()`.
- `cli/src/commands/baseline.ts:146-151` — delete the second scan; derive from the run at `:137`.
- `cli/src/commands/upgrade.ts:249-254` — same deletion; its **remaining** multi-walk structure
  (`:191`, `:246`, plus the rescans inside delegated `baselinePrune`/`baselineAccept`) is out of
  scope. Leave a note in the file; do not fix it here.
- `cli/src/errored-run.ts:23` — corrects a doc comment that references the deleted method.

**Success Criteria**
- No code path merges source-domain and manifest-domain files into one set (decision 2).
- `prune` behaviour is unchanged on a stable tree — this stage is a refactor, not a fix.

**Tests**
- `prune` results identical to the two-scan version on a stable tree.
- `cli/test/nested-checkout-scan-scope.test.ts:109` documents the third scan explicitly — re-point
  it to assert one scan.
- Security-gate entries still reconcile against the manifest domain only.

**Status**: Complete (2026-08-17, commit `25ccf98`)

Measured at completion: typecheck 0 errors, **1258 passing + 1 skipped**, every prune/upgrade suite
green (55 tests), `align check` green, `doctor` exit 0, `--targets local` 15/15 PASS.

**The first success criterion is met in substance but NOT literally, and the difference is
deliberate.** `baseline prune` still unions the two domains, because it cannot not: `store.prune`
takes a single `knownFiles` and `applyMoves` iterates every entry regardless of gate, so a
per-domain split would make each domain's entries look unobserved during the other's pass — mass
over-retention at best. The deleted helper unioned them too. What changed is that the merge is now
explicit, at the one call site that needs it, derived from the run that produced the violations, at
no extra I/O — instead of hidden inside a helper that walked again. `CheckRun` keeps the domains
apart so that consumer makes the choice visibly. Splitting `store.prune` by domain would need the
store to know which gate produced each entry, which is a larger interface change than this stage.

The second walk was never a performance complaint: it only scanned, never running the guard steps or
rule evaluation that are `check()`'s actual error sources, so an errored run still produced a
healthy-looking file set. Pinned by "one walk per domain per check" in core (counting fakes) plus a
value-level assertion the escape hatch is gone — it was reachable from JS consumers, not only
TypeScript ones.

---

## Stage 4: Prune floor, and the retention escape hatch

**Goal**: close the degenerate-scan hole, and stop retention from becoming a permanent leak.

**Work**
- `cli/src/commands/baseline.ts` — refuse when the scan observed nothing, independent of component
  `empty:` policy. Sits alongside ADR 023's tier 1/2 guards as a third refusal. **Not overridable**
  (decided 2026-08-16): an empty scan carries no information to reason from, so there is nothing an
  override could be based on — this is tier-1 shaped, like `refuseIfRunErrored`, not tier-2.
- Escape hatch: `align baseline prune --forget-unscanned <prefix>` — forfeits retained entries under
  an explicit path prefix. It is a destructive write, so: ADR 023 guards, an ADR 026 declared
  write-set, and a required explicit prefix (no bare form that forfeits everything).
- Advisory output distinguishes "nothing to prune" from "everything retained, here is why".

**Success Criteria** — *as originally written; NOT met as stated, and deliberately so. The floor
this criterion describes was built, reviewed, and removed on 2026-08-17. Read the Status section
below before treating any of this sub-section as a description of shipped behaviour.*
- The floor fires on the configuration `align init` itself generates — `components/registry.ts:162`
  skips the zero-match check for anything not `empty: 'fail'`, and `commands/init.ts:146-152` sets
  `until-populated` on every zero-file component (`--greenfield`: on all).

**Tests**
- Everything-excluded scan under `empty: 'allow'` and `'until-populated'` → refusal, **not** mass
  delete at exit 0.
- Partial shrinkage under `empty: 'fail'` still reaches the per-entry guards — the floor is not a
  substitute for Stages 1-2.
- Escape hatch: refuses on an errored run, respects `--allow-incomplete`, writes only its declared
  set, and refuses without a prefix.

**Status**: Complete (2026-08-17), **redesigned the same day after adversarial review** — see below.

Measured at completion: typecheck 0 errors across all five packages (src and tests), **1308 passing
+ 1 skipped**, `align check` green with 29 baselined, `doctor` exit 0, `--targets local` 17/17 PASS.
Not yet measured for flakiness; Stage 5's "15x on the new suites" applies to all three Stage 4
scenarios.

### What shipped is NOT what this stage originally specified

The plan called for a **floor**: refuse the whole run when the scan observed nothing. That shipped,
was reviewed, and was removed the same day. Recording why, because the reasoning is the reusable
part:

1. **The literal predicate was dead code.** `run.observedFiles.source.size === 0` is unreachable —
   `align.config.ts` is a root-level `.ts` file and becomes a graph node, so the observed set is
   never empty (measured: `observed.source: ['align.config.ts']`).
2. **The replacement predicate — every declared component ungrounded — missed the case the stage
   existed for.** Two independent reviewers reproduced it against the built binary: with one
   component's directory absent and another still grounded, `align baseline prune` printed
   `Pruned 1 fixed violation(s)`, exited 0, and emptied the baseline. Verified again by hand. That is
   CLAUDE.md rule 6's severity-zero class, and this plan asserted the opposite as measured fact.
3. **It trapped legitimate repositories.** Non-overridable and evaluated before the partition, it
   blocked a manifest-only greenfield repo from pruning OR re-running `init`, with no way out —
   reintroducing the one-way ratchet the escape hatch was built to remove.

The shape of the mistake, worth carrying forward: **a whole-run guard placed against per-entry
damage**. It is a sibling of ADR 027's F1 (fixed one arm, missed the other) and of ADR 028's own
premise (absence treated as evidence).

### What replaced it

**Mechanism 3 — the missing-directory test** (`cli/src/scan-blind-spot-retention.ts`). An entry whose
file is absent from disk AND whose directory produced no observed file at all is RETAINED, not
forfeited. A real deletion leaves its siblings behind; a missing tree takes them all with it. It sits
beside mechanisms 1 (blind-spot record) and 2 (existence probe) at the granularity the damage
actually has, needs no classification and no workspace index, and covers both routes reviewers found
— including the catch-all-selector route that a per-component fix would have missed.

Root-level entries test against `''`, whose observed set is everything the scan saw, so
manifest-domain entries are never retained by this arm on a healthy scan. That is deliberate: it is
what prevents mechanism 3 from re-creating the greenfield block the floor caused.

**The honest limit**: mechanism 3 cannot distinguish "this checkout lacks the directory" from "I
deleted the directory to pay down the debt". It moves the ambiguity from the file to the directory
rather than removing it. The sound distinguisher is external state — git's index (`git ls-files`
lists a sparse-checkout file but not a deleted one), or a persisted record of the last successful
scan. Both are ADR-sized decisions about a new dependency and are deferred; recorded here so the
limit is known rather than discovered.

**The consent gate (ADR 006)** is what makes that limit affordable. Because deleting dead code is the
commonest way baselined debt is paid down, and mechanism 3 retains on exactly that path, every
deletion `prune` performs now asks: interactive prompts, non-interactive refuses without `--yes`
("silence is never consent"). A run that deletes nothing is never gated, so `prune` stays safe in a
pre-commit hook, and `upgrade` forwards the consent it already obtained rather than asking twice.

### Also fixed from the same review

- `describePruneOutcome` was fed the POST-split retained count, so forfeiting the only retained entry
  printed `Nothing to prune — no baseline entry is orphaned` above `Forgot 1 retained entry ... is
  deleted`. The exact false-headline class that function exists to prevent, reintroduced by the
  commit that added the flag. Found independently by both reviewers.
- `mutations.mjs` claimed `align init` writes `empty: 'allow'`; it writes `until-populated`, and
  `'allow'` exists only in init's throwaway in-memory probe ruleset (rule 5).
- The `--forget-unscanned` test named "and only those" ended in `toEqual([])`, an assertion identical
  whether the hatch is scoped or forfeits everything. It now keeps a surviving entry the prefix must
  not reach.

### Scenario coverage for the findings

- `partial-checkout-retains` (new) — the severity-zero pin, **verified red-before-green in that
  order**: with mechanism 3 disabled and nothing else changed it fails at three steps. Its header
  records that on nest's `complete: false` scan the direct prune is caught by tier 2 first and the
  data loss surfaces at the delegated `upgrade` step, so the exit-0 form is pinned at fixture level
  instead — the scenario does not overclaim what it reproduces.
- `prune-forget-unscanned-retained` — extended with the consent-gate refusal and a
  `stdoutNotContains: 'Nothing to prune'` guard on the forfeiting run.

## Stage 5: Proof, and the release surface

**Goal**: pin the behaviour where it actually runs; document the change for users.

**Work**
- Three integration scenarios (ADR 025) with declared write-sets (ADR 026): **symlink**,
  **unreadable directory**, **excludes-shrink**. Each asserts the entry survives, the advisory names
  the reason, and `align check` does **not** forge a transfer. **DONE 2026-08-18** —
  `blind-spot-{symlink,unreadable,excludes-shrink}-retains.mjs`, red-before-green measured for each
  (see below). Three corrections to the plan as written, all measured:
  - **The advisory does not name the reason for the excludes case, by design.**
    `ADVISORY_BLIND_SPOT_REASONS` omits `excluded` and `default-excluded-dir` because the user
    authored those patterns. Verified against the built binary: `align check` prints no
    `scan-blind-spot` advisory in that state, so the reason reaches the user through `prune`'s
    retention line and nowhere else. The scenario asserts what is true rather than what the plan
    assumed.
  - **Only the unreadable case isolates mechanism 1.** With the blind-spot record disabled and
    nothing else changed, the symlink and excludes scenarios still PASS — a readable directory lets
    the file-existence probe answer "present" on its own. Both mechanisms must be disabled before
    those two fail. The redundancy is real and is now documented in each scenario's header rather
    than implied.
  - **The `unreadable` scenario cannot run as root** (`chmod` does not stop root). The mutation
    verifies its own precondition and throws a named error rather than passing vacuously.
    **RESOLVED 2026-08-18**: `integration/Dockerfile` now sets `USER node`, switching before the
    install/build steps so nothing needs a `chown -R` across an installed monorepo. Measured after
    the change: the image builds, runs as `uid=1000(node)`, and the scenario PASSES all 15 steps
    inside `docker run` — where before it could not run at all. Both supported paths
    (`.github/workflows/ci.yml` and the container) are now non-root and agree.
- ~~Carried from Stage 4, reporting only: decide whether the floor should suppress or qualify
  `align upgrade`'s `baselined debt: N → 0` line ... this is a wording decision, not a gap.~~
  **INVESTIGATED 2026-08-18 — it is a gap, and wider than `upgrade`.** Measured against the built
  binary on a two-entry world hidden behind one `excludes` pattern: `align check` prints
  `baselined debt: 2 → 0 (-2)`, `verdict: green`, **exit 0**, with both accepted entries still in
  `.align/baseline.json` and nothing fixed — while `prune` on the same state correctly reports
  `Retained 2 entries`. `computeBaselineDebt` already refuses to report a drop on an errored run,
  with a comment naming this exact hazard; ADR 028 introduced a second cause of the same
  fabrication and the guard was never extended to it. Filed as **LEDGER D016** with the fix
  direction; not a wording change, and `check` — not `upgrade` — is the common path.
- `integration/lib/` — new assertion kinds if needed; register in `spec-validate.mjs` (the
  `jsonArrayEveryHasField` precedent). **No new kinds were needed** — `fileUnchanged`,
  `jsonArrayLength` and the `stdoutMatches`/`stdoutNotContains` pair covered all three scenarios.
  What `spec-validate.mjs` did gain is `validateNoDuplicateKeys`, which is the S-05 promotion rather
  than an assertion kind.
- `UPGRADING.md` — 0.2.0 note: retention is a behaviour change users will notice. **DONE 2026-08-18**
  ("A baselined entry align could not look at is retained, not pruned"). Note for whoever edits that
  file next: `packages/cli/src/migrations/notes.generated.ts` must be recompiled with
  `pnpm -F @spikedpunch/align-cli compile-notes` or `migration-notes-drift.test.ts` goes red — which
  is the drift detector working, and it caught exactly this during Stage 5.
- `README.md`, `packages/cli/README.md`, `packages/agent/README.md` — carried queue item
  (auto-exclusion + `includeNestedCheckouts`), now also blind-spot reporting. **PARTIALLY DONE
  2026-08-18, and the remainder is stated rather than quietly dropped.** Blind-spot reporting and
  the retention behaviour are now in all three. `includeNestedCheckouts` — the opt-back-in export —
  is documented in `packages/cli/README.md` only; the root and agent READMEs describe the
  auto-exclusion but never name the escape hatch. That may well be the right split (a config export
  belongs in the CLI reference), but it is a judgement nobody has made explicitly, so it is recorded
  here as open rather than marked complete.
- `docs/core-interfaces.md:618-631` — the documented `McpCheckPayload` block is **already stale by
  four fields** (it stops at `advisories`; the real interface continues with `ungroundedComponents`,
  `skippedNestedCheckouts`, `baselineDebt`, `complete`). Bring it to reality, including `blindSpots`.
  **DONE 2026-08-18** — all four added, and the block now carries an `<!-- ENFORCED against ... -->`
  marker pointing at the test below.
- **Enforce that block against the type** so it cannot drift again. **DONE 2026-08-18** —
  `packages/core/test/core-interfaces-doc.test.ts`, with a calibration test and a red-before-green
  check (removing `complete` from the markdown fails it). Measured drift on arrival: the block was
  four fields behind (`ungroundedComponents`, `blindSpots`, `baselineDebt`, `complete`). — this is the mechanism that
  actually failed here; a payload version field would not have caught it. No existing doc-integrity
  harness to extend (checked: ADR 018's machinery covers doc-built rules, not markdown type blocks),
  so this is new: extract the `ts` block from the markdown and compare its field list against the
  `McpCheckPayload` declaration via the TypeScript compiler API — already a dependency through
  `plugin-typescript`, and the idiomatic choice here over a runtime key-comparison, which cannot see
  absent optional fields like `pagination?`.
- `docs/adr/027-*.md` — amend with a pointer to 028 as the generalization of its closing lesson.
  **DONE 2026-08-18**: "Amendment (2026-08-18): that enumeration was done, and the answer was worse
  than this ADR assumed".
- `ARCHITECTURE.md` — §3's data flow gains the blind-spot record. **DONE 2026-08-18** (step 2b), and
  written as load-bearing rather than diagnostic: it names the three consumers that infer meaning
  from absence, which is the fact a reader needs.
  - ~~Also fix the false citation at `orchestrator.ts:248` ("sole owner of scanning,
    ARCHITECTURE.md §5")~~ — **STALE, no action needed.** Verified 2026-08-18: the string "sole
    owner" appears nowhere under `packages/`. `git log -S` puts its removal in `25ccf98` ("delete
    orchestrator.knownFiles(); prune scans once", Stage 3 of this plan) — the comment went with the
    method it documented. The remaining `ARCHITECTURE.md §5` citations in `orchestrator.ts` (lines
    31, and §3 at line 45) were checked against the document and are accurate. Recorded rather than
    deleted because a plan item that quietly disappears reads, later, as one that was forgotten.

**Success Criteria**
- `expectFailOn: ['0.1.4']` added **only after** `local` goes green, so a red run distinguishes the
  bug from a scenario that never ran. **DONE 2026-08-18**, and the earlier worry that 0.1.4 might
  fail these for the wrong reason (unable to load the generated config) was a hypothesis and is
  false: measured against the published 0.1.4 tarballs, it loads the world's config and finds both
  violations. All three then fail at **step 9 — the pin** — with `align check` going red -> green at
  exit 0 and one accepted entry re-homed onto the never-reviewed bait (`baselined debt: 2 -> 1 (-1)`).
- Full matrix `--targets 0.1.4,local` green, calibration intact. **DONE 2026-08-18, BOTH PROJECT
  LINES** (the D012 trap: `run.mjs` filters by project, so the default `--project nest` alone skips
  every scenario declared against another one):
  - `--targets 0.1.4,local` — 20/20 PASS on local, 6 FAIL on 0.1.4, exit 0, no calibration break.
  - `--targets 0.1.4,local --project nest-incomplete` — 1/1 PASS on local, 1 FAIL on 0.1.4, exit 0.
- **Audited: every one of the seven `expectFailOn` pins fails on 0.1.4 at the step its own header
  claims**, not for an incidental reason. `expectFailOn` can only see pass/fail, never which step,
  so this had to be read out of the logs rather than inferred from the green matrix:
  the three blind-spot scenarios at step 9; `init-rerun-preserves-content-fingerprint` at step 8
  (0 of 389 entries kept `contentFingerprint` — its header's "fails at step 8 and NOT earlier" is
  accurate); `mcp-propose-rules-baseline-gate` at step 4 (no gate at all);
  `prune-errored-run-destroys-baseline` at step 7 (exits 0 and destroys the baseline);
  `prune-incomplete-scan-requires-allow-incomplete` at step 8 (no tier-2 refusal — deletes 371
  entries at exit 0). That last one was the suspect, because its later steps use `--allow-incomplete`
  and `--yes`, both of which postdate 0.1.4 and would fail as unknown options; they do, at step 10,
  *after* the real pin has already fired. `prune-forget-unscanned-retained` continues to decline a
  pin for exactly that reason and is correct to.

**Tests**
- The three scenarios red before the fix, green after — verified in that order.
- Flaky confirmation: 15× on the new suites. **DONE 2026-08-18, both halves clean.**
  - Integration, `--targets local` on the three scenarios, 15 iterations: **45/45 scenario verdicts
    PASS, 0 non-zero exits.** Wall time per iteration min/median/max 114 / 123 / 129 s, stdev 5.1 s
    (4.2% of the mean) — recorded because a timing-sensitive flake usually shows as a heavy right
    tail before it shows as a failure, and there is no tail here.
  - `packages/core/test/core-interfaces-doc.test.ts`, 15 runs: **15/15, 3 tests each.** Run after
    the integration loop rather than beside it, so the load did not contaminate the timing above.
  - **What this does and does not rule out.** 15 clean trials are consistent with a per-run failure
    probability as high as **18.1%** at 95% confidence (30 trials would be needed for <10%, 50 for
    <6%). This is evidence against a frequent flake and says little about a rare one; the number is
    written down so nobody later reads "15× green" as "deterministic".

**Status**: **Complete** — with two things deliberately carried out of the stage rather than closed
inside it: LEDGER D016 (the fabricated debt drop, filed with a fix direction, tracked separately),
and the `includeNestedCheckouts` README judgement noted above.

---

## Explicitly out of scope for 0.2.0

- **The pipeline reframe** (ADR 028 §7) — own ADR, own release. Destructive commands first
  (`prune`, `upgrade`, `init`); `upgrade` collapsing from ~6 walks to 1 is the largest single win.
- **Concurrency**: `cli/src/align-dir.ts:206-209` is a non-atomic full-snapshot write with no lock;
  the MCP server racing a CLI `accept` can lose a consent decision. Own ADR.
- **Case-only renames on case-insensitive filesystems** (ADR 028 mechanism #8) — known gap.
- **Whether align should follow symlinks at all** — Stage 1 records them; it does not decide this.
- ~~**The manifest domain's own exits** — malformed-`package.json`-as-absent (`manifest.ts:44-50`) and
  its exclude dialect diverging from the source walker's (`manifest.ts:80-83` vs `scanner.ts:250-255`).
  Same class, second walker. Should be next, not last.~~ **DONE 2026-08-18, LEDGER D017**, and this
  entry was wrong in both halves in a way worth recording. The `manifest.ts:44-50` exit named here
  was already dead code — ADR 028 F3's rewrite of `buildManifestRecord` orphaned `readJson` and
  nobody noticed, so "closing" it meant deleting a corpse. The live exits were somewhere else and
  there were **four** of them, one layer up: `readWorkspaceGlobs` (three declaration files),
  `safeReaddir` in the glob walk, and `readLockfile`. All four silently shrank the scan and recorded
  nothing — measured. The exclude-dialect half was real and is closed by importing the source
  walker's `matchingExcludePatternForDirectory` rather than growing a third copy of the dialect.
  **Lesson for the next out-of-scope list**: an item written as two file:line citations decays into
  a false map of the problem. Cite the property, not the lines.
- **`custom.host` seatbelt rule** confining scanner imports — catches only the five direct-scan
  projections, misses `baseline.ts`/`upgrade.ts`. Belongs with the reframe.

## Carried, unrelated to this ADR

F3, F4, wt-25d (dry-run rails), wt-25e (escalation output), array-selector `TypeError` in
`parseSelector`, `init/npm-script.ts`'s untested interactive branch, backfilling `contentFingerprint`
in `init` for entries with no prior, release chain #11→#12→#13.
