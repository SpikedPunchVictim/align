# Handoff — align 0.2.0 release work

**Written 2026-08-11, updated 2026-08-16.** Branch `fix`, **80 commits ahead of `main`**, **no
upstream, nothing pushed**. Version is **0.2.0** across all five packages.

> ### ⚠ The working tree does not compile right now, and that is expected
>
> Mid-flight on **ADR 028 Stage 1**. Uncommitted:
>
> ```
>  M packages/core/src/gates/types.ts      # CheckRun: blindSpots + observedFiles
>  M packages/core/src/types/graph.ts      # ScanBlindSpot types; blindSpots replaces skippedNestedCheckouts
>  ?? docs/adr/028-2026-08-16-scan-blind-spots-and-the-absence-inference.md
>  ?? docs/adr/proposals/scan-blind-spots/IMPLEMENTATION_PLAN.md
> ```
>
> `pnpm typecheck` reports **exactly 12 errors, all in core** (`orchestrator.ts` ×11,
> `payload/builder.ts` ×1), every one of them `skippedNestedCheckouts` no longer existing. That is
> the types-first migration working as intended — the compiler is enumerating the work. If you see
> a different count or a different shape of error, something else changed and you should find out
> what before continuing.
>
> **Start by reading `docs/adr/proposals/scan-blind-spots/IMPLEMENTATION_PLAN.md`.** It has the five stages with
> file-and-line work lists. `docs/adr/028-*.md` is the authoritative reasoning behind them.

Read this, then `CLAUDE.md` (destructive-safety rules — binding on new work), then
`docs/adr/021`–`028`. The ADRs are authoritative; this file only tells you where
things stand and what is not obvious from the code.

---

## Verification baseline — establish this before changing anything

```
pnpm build && pnpm typecheck && pnpm test
node packages/cli/dist/index.js check     # must be green
node packages/cli/dist/index.js doctor    # must exit 0
```

Last full-green measurement, at commit `f0b48c7` (2026-08-14, before the ADR 028 type changes):
**1203 passing + 1 skipped**, `align check` green, all 15 local integration scenarios PASS,
`nest-incomplete` PASS, 0.1.4 red as calibrated. Measured wall-clock: **~26s for the whole gate**,
so run it always. The Docker harness costs ~38s per scenario (~9m for the full local suite); use
the tiers.

To re-establish that baseline while the tree is mid-migration:
`git stash && pnpm build && pnpm typecheck && pnpm test` — then `git stash pop`. **Do not** commit
or discard the stash without reading the warning at the top of this file.

If the stashed baseline does not reproduce, stop and find out why before doing anything else.

## What shipped this session

Five ADRs, all committed: **021** version provenance, **022** `version.json` + `align upgrade` +
migration registry, **023** incomplete-scan refusal, **024** MCP baseline-acceptance gate, **025**
cross-version integration harness.

**Task #16 (`align upgrade`) is complete** — five slices: `.align/version.json`; the three-tier
migration registry (notes / validators / transforms); notes compiled from `UPGRADING.md`; the
`upgrade` command with `--notes` / `--from` / `--allow-incomplete` / `--yes`; and the first real
transform (rewriting drifted interior-`**` selectors).

**The integration harness exists and is a release gate** (`integration/`). 15 scenarios, 2 projects
(`nest` pinned at `c3bc75c97`, and `nest-incomplete` without dependencies). Run it:

```
node integration/run.mjs --scenarios <id> --targets 0.1.4,local
```

Three scenarios carry `expectFailOn: ['0.1.4']` — they MUST fail against the published 0.1.4 and
pass against `local`. That is the harness's calibration. **If those ever go green on 0.1.4, the
harness has stopped working and nothing it reports can be trusted.** CI runs it on
`workflow_dispatch` and on `release`, never on push/PR.

---

## Pending work

Ordered by what I would do next. Every item was deliberately deferred with reasoning, not forgotten.

### Closed on 2026-08-12 (see git log for the commits)

**#21** — ADR 023 amended: tier 2 now covers BOTH of `init`'s write paths through one guard, with
`--allow-incomplete`. Reproduction found a second destructive path the original write-up missed —
the `--accept-existing` seed path silently dropped accepted entries the scan no longer observed.
`init` also stopped restamping `acceptedAt`/`acceptedBy` on entries it did not author, and now
refuses on a corrupt `baseline.json` instead of overwriting it.

**#27** — `generatedRulesContentHash` now digests an explicit `{ irVersion, docPath, rules }`, so
it is reproducible. `generatedAt` stays (provenance, read by nothing). `verifyFrozenRules` accepts
either hash: a legacy raw-bytes match reports "this lockfile predates the reproducible hash", never
the tampering message. `UPGRADING.md` has its first `## 0.2.0` section; ADR 011 has the amendment.
**The legacy fallback is temporary — delete it in a later major.**

**#22** — `areAdvisoriesComplete(advisories)` is now the one place the `missing-dependencies`
literal is compared; `isRunComplete(run)` delegates, signature unchanged. Verified by repo-wide
grep, not by trusting this document's claim that doctor's was the last copy.

**ADR 026 (new) — declared write-sets.** A command may only touch what its scenario declares. The
harness snapshots the whole tree (it previously captured a named allowlist and literally could not
see the bytes BUG #10 destroys), write-sets are fail-closed so a new scenario must declare, and
`align.config.ts`/`CLAUDE.md` carry a marker-region clause. Mirrored as a unit-test helper
(`packages/cli/test/write-set.ts`) that runs in the 26s gate. `CLAUDE.md` carries the short
enforceable version — read it before adding a feature that writes.

It found two writes nobody had ever seen: `init` appends telemetry entries to `.gitignore` on every
run, and `offerAlignScript` adds the npm script to `package.json` on every non-interactive run.
Both legitimate, both now declared.

Also closed: `build.ts` split at the verification seam (was 498 of a 500 cap — two lines from red);
`ensureAlignDir` removed from `runInit` entirely (redundant — `writeBaseline` and
`recordBaselineReconciled` self-ensure), so every refusal path now writes nothing; and a shared
`defaultConfirm` + `confirm` test seam across `init`/`upgrade`/`build`, which made the interactive
consent branches reachable by tests for the first time.

### The flaky test — fixed on diagnosis, NOT on repeated-run evidence

`upgrade-transform.test.ts`'s "idempotent end to end" was hit by four independent agents, always as
`Test timed out in 5000ms`, never as a wrong-value assertion — a duration problem, not a race. It
drives `runUpgrade` twice (real git subprocesses plus two full scans), 1–3s quiet against vitest's
5s default. Both real-git transform files now carry an explicit 30s budget.

**This is the one change in the batch committed without its own verification.** The 15-consecutive-
run check never completed, and the reproduction environment was contaminated by four concurrent
agents on one machine. Re-run the suite ~15x on a quiet box and confirm before the release.

### #25 — nested checkouts: **MERGED AND SHIPPED as ADR 027.** History below, kept for context

The eight `wt-25*` / `wt-docs-*` worktrees were **removed on 2026-08-16**, after verifying each was
clean (no modified or untracked files), its HEAD was an ancestor of the branch, and it held zero
commits not already in `fix`. `git worktree list` now shows only the main tree, and
`.claude/worktrees/` is gone — so the working tree is exactly the two in-flight type files.

The eight **branches** (`wt-25`, `wt-25b`…`wt-docs-b`) still exist and are fully merged into `fix`.
They are harmless labels; delete them with `git branch -d` if you want the namespace clean.

The rest of this section is the historical record of how #25 landed. Its "STILL OWED" list is
resolved — see the note at its end. **ADR 027's closing section is the thing to actually read**:
"changing what a scan sees is never local to scanning" is the lesson ADR 028 generalizes.

**Decided design** (user's call): (1) auto-exclude — during the walk, skip any non-root directory
containing its own `.git` (a *directory* for a clone/submodule, a *file* for a linked worktree);
(2) never silent — every skip is reported as a `nested-checkout-skipped` advisory on `check` AND
`doctor`, because a component whose files all live under a silently-skipped path would evaluate
vacuously green (ADR 008 reference-validity, ADR 003 `empty:` policy); (3) opt-out via an
`includeNestedCheckouts` export in `align.config.ts`, default off.

**A Fable review verdict: merge with fixes, one blocking.** What it verified as SOUND — do not
re-review these: the skip logic (both `.git` shapes, once per directory not per file, root
structurally exempt via `relDir === ''` with a genuine test); the implementer's claim that
`validateComponents` throws before any graph exists, so that diagnosis must live in the thrown
message; advisory reachability on every other path (green run, both guard-step error returns,
`empty: 'allow'`, doctor's direct scan and its scan-error catch, `--untrusted`, MCP); and the
`ExportedRuleset` addition being compatible via `z.array(z.string()).default([])` in a non-strict
object — **no `irVersion` bump, which would break old artifacts for nothing.**

**Blocking finding — FIXED in the worktree, but I never re-verified it in the main tree.** The
defect: `includeNestedCheckouts` was not threaded through 7 call sites (`mcp/server.ts:45`,
`baseline.ts:31/112/123`, `upgrade.ts:190/245/250`, `init.ts:210`). Consequence for a user who opts
a checkout back in: `baseline accept` could never clear a red check, and **`baseline prune` deleted
their accepted entries and exited 0** — the files were absent from prune's `knownFiles`, so
`store.prune` removed them as unmatched orphans while printing success. Neither ADR 023 guard fires,
because the run is green AND complete: the inconsistency was in scan *scope*, not run status.
`mcp/server.ts:31-41` carries a comment naming that function as the one that keeps getting missed by
cross-cutting changes, with two prior instances; this was the third.

The worker reports all 7 threaded, a `grep -rn '\.check(\|\.knownFiles(' packages/cli/src` showing
all 11 call sites now passing the option, and a new end-to-end regression test
(`packages/cli/test/nested-checkout-scan-scope.test.ts`) covering check → MCP → accept → prune
against a violation inside an opted-in checkout. It says it confirmed the test actually catches the
regression by reverting the fix, seeing the failure, and restoring — worth reproducing, since that
is the only claim that makes the test worth having. Also fixed: the deeper-selector probe miss (new
`staticPrefixOf` in `components/glob.ts`, OR-ed with the existing probe match), the three inaccurate
comments, and an ADR 014 amendment for the fifth artifact field.

Reported counts inside the worktree: **1158 passing + 1 skipped** (create-align 46, core 463,
plugin-typescript 88, agent 53+1, cli 508), check green with 29 baselined, doctor exit 0. **I did
not independently re-run any of this** — the session ended first. Reproduce it in the worktree
before trusting it, then merge.

**All four "STILL OWED" items are closed:** (1) prune retention shipped as
`cli/src/nested-checkout-retention.ts`; (2) the ADR is `docs/adr/027`; (3) the integration scenario
exists; (4) `UPGRADING.md`'s 0.2.0 section carries the note and the registry is keyed to 0.2.0.

---

### ADR 028 — scan blind spots: **IN PROGRESS, Stage 1 started.** This is the live work

**Read `docs/adr/proposals/scan-blind-spots/IMPLEMENTATION_PLAN.md` first**, then `docs/adr/028-*.md`. Both are
uncommitted. The plan has file-and-line work lists per stage; do not re-derive them.

**The defect class**, in one line: `!knownFiles.has(entry.file)` is read as "this file was deleted",
but it actually means "this scan produced no node for this path". Every gap between those is either a
silent deletion of a consent record, or — worse — a **forged move-transfer** that stamps a real
human's `acceptedAt`/`acceptedBy` onto a violation nobody reviewed and turns `align check` green.
The transfer arm fires on **every plain `align check`** (`orchestrator.check` → `reconcileMoves`,
`check.ts:114` persists unconditionally). No destructive command, no flag, no completeness gate.

**Nine mechanisms enumerated** (ADR 028 has the table with sites). Three were unknown when ADR 027
was written, and two are reproduced against the built binary:

- **symlinks** — `readdirSync(…, {withFileTypes:true})` does not follow links, so `isDirectory()`
  and `isFile()` are BOTH false and a symlink matches neither branch of the walk. An entire
  symlinked subtree vanishes with no record, not even an uncertainty marker. Fixture + probe output
  is in the ADR; re-runnable from
  `…/scratchpad/mysym/repo` if that scratch dir survives, trivially rebuilt if not.
- **unreadable directory** — `catch { return }` at `scanner.ts:224`, still silent even after this
  release's `unverified-prune.ts` work, because that only reports entries WITHOUT a
  `contentFingerprint` and `baseline accept` always writes one.
- **`excludes`** — reproduced: accept a violation, add a second file with the identical import, then
  exclude the first file. `align check` exits 0 GREEN with the entry's `file` rewritten to the
  second file, carrying the original provenance.

**The decision is two overlapping mechanisms, and both are required** — this is the part most likely
to be "simplified" by someone who has not read the measurement:

1. the walk records every blind spot with its reason (`ScanBlindSpot`), and
2. an **injected** existence probe covers causes nobody enumerated.

Neither alone works. `fs.existsSync` returns **false** for a file inside a `chmod 000` directory —
it swallows the `EACCES` — so the probe alone misses mechanism #5, one of the two reproduced
severity-zeros. The record alone is exactly as complete as our enumeration, and this ADR exists
because the previous enumeration missed three. The probe must be injected because **`packages/core`
imports `node:fs` nowhere** and that stays true.

**Decisions already made — do not relitigate without new evidence:**

- The **pipeline reframe is deferred** to a later release with its own ADR (ADR 028 §7). An earlier
  diagnosis blamed this bug class on commands re-deriving inputs mid-invocation; that diagnosis was
  **retracted before implementation** — the confirmed defects fire on a single-walk `check` with the
  chain intact. The multi-walk sprawl is real, ugly, and has zero confirmed kills.
- **Empty-scan prune refusal is NOT overridable** — tier-1 shaped, because a scan that observed
  nothing carries no fact an override could rest on.
- **The payload rename is free only in this release.** `CheckPayload` is unversioned; verified no
  published version emits `skippedNestedCheckouts` (`v0.1.4`'s builder has zero occurrences).
- **The migration validator stays checkout-specific.** `migrations/validators/baseline-entries-in-skipped-checkouts.ts`
  is wired into the 0.2.0 registry entry. Symlink/exclude blindness are standing bugs, not
  consequences of upgrading, so widening it would misreport them.

**Also found, deliberately out of scope, each recorded in ADR 028:** the manifest walker's own exits
(malformed `package.json` treated as absent — the corrupt-≠-absent discipline BUG #1 banned, in a
second walker — and an exclude dialect that diverges from the source walker's); `writeBaseline` is a
non-atomic full-snapshot write with no lock, so the long-lived MCP server racing a CLI `accept` can
lose a consent decision; `docs/core-interfaces.md`'s documented payload block is already stale by
four fields, with nothing enforcing it.

### The last unseamed prompt

`init/npm-script.ts` still owns its own `readline` prompt. Deliberately not unified into
`defaultConfirm`: it is `[Y/n]`, default YES, a different consent contract that unifying would
silently flip. It has no `confirm` seam, so its interactive branch is untested.

### #24 leftovers — harness coverage gaps (acceptable, recorded)

`doctor` beyond always-exit-0; multi-hop `--from` (untestable — only one registry entry exists);
version-skew with two versions installed; `docs`/`skill` diffed across versions. `agent` is
permanently out of scope (needs a live model; the harness must stay model-free).

### #11 → #12 → #13 — the release chain

**#11 bump the version.** Use `pnpm release:version`. 0.2.0, not 0.1.5 — this release has breaking
behaviour: baseline fingerprint churn across four rule kinds, `prune` now refusing on errored and
incomplete scans, and MCP `accept_new_into_baseline` gated off by default.

**Do not forget:** after bumping, **re-run `align skill --install`** and confirm `align doctor`
reports no stale-skill advisory. The skill snapshot carries the version stamp, so any bump re-stales
it, and the content hash does not save you — the version branch short-circuits first. This was
verified the hard way.

Then #12 push + PR, #13 publish per `RELEASING.md` (five packages, lockstep versions).

---

## Things that are not obvious and will cost you if you miss them

**How this user works.** Implementation goes to **Sonnet subagents**; coding standards live at
`/Users/spikedpunchvictim/temp/enterprise-apps/CODING_BEST_PRACTICES.md`. Subagents are told **not
to commit** — the managing agent verifies, then commits. The user rewards blunt, evidence-cited
assessment and pushes back on hand-waving. Present findings and wait for sign-off before starting a
new stage.

**Parallel agents: provision worktrees yourself.** `isolation: "worktree"` on the Agent tool
provisioned from a stale base twice out of three on 2026-08-12 — one agent nearly built against a
51-commit-old tree and caught it only via the test-count baseline. Use
`git worktree add -b <name> .claude/worktrees/<name> <sha>` and point plain agents at the absolute
path. Give every agent a test-count baseline to verify BEFORE it starts; that is what caught it.
Concurrent agents on one machine also contend enough to cause timeout flakes — see the flaky-test
note above.

**Verify agent reports; do not relay them.** Multiple times this session a subagent's summary was
directionally right but wrong in a detail that mattered, and twice a subagent reported test counts
measured against a tree another agent was concurrently editing. Re-run the gates yourself.
Specifically: when two subagents share a working tree, their test numbers are worthless — use a
git worktree, or run them sequentially.

**The recurring defect class in this codebase: a doc comment asserting a guarantee nothing
implements.** Found three times in four days — `allowBaselineFromMcp` (documented gate, never
built, while an ungated MCP path wrote the baseline), the harness's `fileUnchanged` docstring
(promised a loud failure on absent-in-both, actually `undefined === undefined`), and the same
shape in `skill/fix-loop-protocol.ts`. **Treat a comment describing a safety property as a claim to
verify, not as evidence.**

**"Reports success wrongly" outranks everything here.** It is the project's severity-zero class and
it keeps recurring: `prune` deleting accepted debt while printing success; the harness's own
false-green paths; a test that silently *skipped* rather than failed. When you find one, hunt the
class, not the instance.

**Cite measured numbers, never invent them.** Two ADRs record cases where a number was applied to a
question it did not bear on (churn magnitude used to justify a decision about provenance
granularity, and again about config-level breakage). Both are written up in ADR 022's Design
Reserve as errors, deliberately.

**`test-apps/` is gitignored** and holds six real external repos with real baselines. Treat it as
read-only working state — copy elsewhere before mutating. `/Users/spikedpunchvictim/projects/grizzly`
is a real user project and was strictly read-only all session.

**The churn number people will want to cite is softer than it looks.** ADR 022's 2.9% (n8n) and the
harness's ~1.0% (nest) are both real measurements, but neither cleanly attributes to fingerprint
churn — both repos scan `complete: false`, so some share may be a completeness artifact. Say
"upper bound", not "the churn rate".

**The version bump to 0.2.0 has happened** (all five packages, lockstep). Two things it broke that
you should expect to see again on the next bump: three tests asserted pre-bump state and had to be
re-pointed, and `version-skew.test.ts` had a fixture pinned to the literal `'0.2.0'` which collided
with the now-real version and silently weakened its own assertion to `undefined` — replaced with a
`'9.9.9'` sentinel. **Bumping the version silently weakens version-pinned fixtures; grep for the
literal before and after.**

**The migration registry has exactly ONE entry (`0.2.0`), and 0.1.4 deliberately has none.** It once
did, keyed wrong: `v0.1.4` is the tip of `main`, every commit the notes describe postdates it, and
`selectRange` takes entries strictly newer than `from` — so `align upgrade --from 0.1.4` selected
nothing. Re-keyed and verified against the built binary: `unknown` / `0.1.4` / `0.1.3` all yield 14
notes. `registry.ts`'s module comment records this.
