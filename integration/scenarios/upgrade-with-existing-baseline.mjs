// ADR 025 §"Priority" item 1 (task #24 increment 2) — the flagship scenario: converts ADR 022's
// "drive it end-to-end on a real repo" compensating control from a ONE-OFF MANUAL run (against a
// scratch copy of test-apps/kluster) into something that runs on every gate. Install a real,
// published 0.1.4, seed a real baseline, install `local`, run `align upgrade`. Proves: the
// transition is reported; consent is REQUIRED before anything mutates; `--yes` (plus
// `--allow-incomplete` — see below) reconciles; `.align/version.json` ends up stamped.
//
// **Why `install: '0.1.4'` with NO `--from` override still exercises the full flow, not the
// trivial "already at current version" shortcut.** This mattered acutely before the 0.2.0 bump,
// when `packages/cli/package.json` still read `0.1.4` and so `local`'s `ALIGN_VERSION` did too —
// a literal `stamp.alignVersion === ALIGN_VERSION` comparison would have looked like a no-op.
// **It wasn't one**, and the reason it wasn't is the reason this scenario still holds now that
// `local` reads `0.2.0`: a REAL published 0.1.4 predates ADR 022
// entirely: it never wrote `.align/version.json` at all (verified empirically, 2026-08-10 — after
// `align init --accept-existing` + `align baseline accept` under a genuine 0.1.4 install,
// `.align/version.json` does not exist). `runUpgrade` (`packages/cli/src/commands/upgrade.ts`)
// reads that absence as `rangeFrom = 'unknown'`, which SKIPS the `rangeFrom !== 'unknown'` early-
// return entirely and selects every registry entry `<= to` (`migrations/range.ts`'s `selectRange`)
// — so the registry's validators, notes, and reconciliation all run for real, printing
// `align upgrade: unknown → 0.2.0`. This is in fact the MORE realistic case: every install made
// before 0.2.0 has no stamp, which is exactly what "install 0.1.4" (a real pre-0.2.0 release)
// produces. The bump landed as anticipated and this scenario needed no edit: its assertions were
// written version-neutral (`stdoutContains: 'unknown → '`), so they carried across unchanged.
//
// Note the notes are now keyed to `0.2.0`, not `0.1.4` — they describe commits that all postdate
// the `v0.1.4` tag, and while they were mis-keyed `align upgrade --from 0.1.4` selected nothing at
// all. This scenario never exercised that route (it passes no `--from`), which is precisely how the
// mis-keying survived the harness. A scenario covering the explicit `--from` path is still owed.
//
// **The measurement question, answered honestly (see the increment-2 report for the full
// writeup).** The churn mechanism this scenario exists to make reproducible is specifically
// `arch.no-cycles` chain extraction (BFS vs. the old greedy walk) — `align init`'s cycles-first
// starter ruleset already includes a repo-wide `arch.no-cycles:repo` rule with no mutation needed,
// and nest genuinely has 18 real cycles at the pinned commit. Measured end-to-end (2026-08-10,
// against a REAL 0.1.4 baseline of 389 entries: 371 `arch.no-dependency:core->common` +
// 18 `arch.no-cycles:repo`): `align upgrade` (no flags) reports `baselined debt: 389 → 385 (-4)`
// and refuses to prune those 4 without `--allow-incomplete`. **This is a real, reproducible
// number, not a fabricated one — but it is NOT a clean isolated no-cycles-churn measurement**: this
// pinned nest commit's OWN dependency install reports `complete: false` (48 unresolved external
// specifiers across 43 files, verified via `align check --json`'s `missing-dependencies` advisory)
// even under the project's own full `npm ci --legacy-peer-deps`, which is WHY `--allow-incomplete`
// is required at all. An orphaned-looking entry on an incomplete scan may be a completeness
// artifact rather than genuine fingerprint churn (ADR 023) — the exact ambiguity ADR 022's own
// n8n evidence names ("some unknown share... may be completeness artifacts rather than fingerprint
// churn"). So: 4/389 (~1.0%) is the real, measured, reproducible number this harness gets today: it
// is smaller than the ~2.8% n8n/kluster figure, consistent with the brief's own prediction that
// nest may have few multi-node SCCs where BFS and the old greedy walk actually disagree — but it is
// reported here as an upper bound with the same completeness caveat, not attributed cleanly to the
// BFS rewrite. Nothing about this scenario's construction inflates or invents the number.
export default {
  id: 'upgrade-with-existing-baseline',
  project: 'nest',
  description:
    '0.1.4 → local upgrade with a real pre-existing baseline (ADR 022, ADR 025 Tier-1 #1): transition reported, ' +
    'consent required, --yes (+ --allow-incomplete) reconciles, .align/version.json ends up stamped.',
  // ADR 026: `align upgrade --yes` is a real reconciliation (internally `baselinePrune` +
  // `baselineAccept`, commands/upgrade.ts) — the destructive path this scenario exists to drive.
  // COMMON set (see init-fresh-project.mjs's write-set comment) covers every path touched: the
  // refused (`upgrade`, no `--yes`) and read-only (`upgrade --notes`) steps write nothing, and the
  // reconciling step only rewrites `.align/baseline.json`/`.align/version.json`, both already
  // declared. No selector-rewrite migration fires here — nest's `init`-generated align.config.ts
  // uses today's pattern syntax, so the glob-double-star transform (the one migration that WOULD
  // touch align.config.ts's rules/components, outside its marker block) has nothing to rewrite.
  tags: ['destructive'],
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json'],
  steps: [
    { install: '0.1.4' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    // Real, deterministic violation debt (same mutation/edge the increment-1 prune/check scenarios
    // use) — guarantees `hasBaseline` is true so `align upgrade`'s prune/accept reconciliation
    // logic actually runs, independent of whether nest's own arch.no-cycles rule (below, seeded by
    // `init` itself — no mutation needed) happens to churn at all.
    { mutate: 'introduce-arch-violation' },
    { run: 'baseline accept', expect: { exit: 0, stdoutContains: 'Accepted 389 violation(s)' } },
    { snapshot: 'after-0.1.4-baseline' },
    // F6-style pin (matching prune-errored-run-destroys-baseline.mjs's own discipline): verified
    // empirically 2026-08-10 — 371 arch.no-dependency:core->common + 18 arch.no-cycles:repo (the
    // latter from init's own cycles-first starter ruleset, real cycles at the pinned commit).
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 389 } },
    // A real, published 0.1.4 predates ADR 022 — see this file's header comment.
    { assert: { kind: 'exists', file: '.align/version.json', equals: false } },
    { install: 'local' },
    // Read-only preview (ADR 022's `--notes`): must mutate nothing, stamp nothing, and must
    // actually assemble the real notes/validator content for the detected range — `unknown → `
    // (no trailing version number, so this assertion needs no `keepVersion` opt-out) proves the
    // transition was computed from a genuinely-unknown stamp, not skipped by the early "already
    // current" return; `arch.no-cycles` proves the compiled UPGRADING.md notes actually printed.
    { run: 'upgrade --notes', expect: { exit: 0, stdoutContains: 'unknown → ', stdoutMatches: 'arch\\.no-cycles' } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-0.1.4-baseline' } },
    { assert: { kind: 'exists', file: '.align/version.json', equals: false } },
    // Consent REQUIRED (ADR 006/022): non-interactive, no --yes — must refuse to mutate, even
    // though it already knows there's something to reconcile (it prints the baselineDebt delta and
    // the tier-2 refusal reason before declining). Verified empirically: `baselined debt:
    // 389 → 385 (-4)`, `refusing to delete 4 entries` (ADR 023 tier 2 — nest's own dependency
    // install is incomplete; see this file's header comment).
    { run: 'upgrade', expect: { exit: 1, stdoutContains: 'baselined debt: 389 → 385', stderrContains: 'refusing to delete 4 entries' } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-0.1.4-baseline' } },
    { assert: { kind: 'exists', file: '.align/version.json', equals: false } },
    // `--yes` (consent) + `--allow-incomplete` (ADR 023 tier 2 override, since this pinned commit's
    // own install is incomplete regardless of any cross-version churn — see header comment):
    // reconciles for real. Net entry count returns to 389 (4 pruned, then 389 re-accepted from a
    // fresh empty-baseline scan) — SAME count, DIFFERENT fingerprints, which is exactly why the
    // assertion below is `fileChanged`, not a count check.
    { run: 'upgrade --yes --allow-incomplete', expect: { exit: 0, stdoutContains: 'Reconciled — baseline is now recorded as reconciled under align' } },
    { assert: { kind: 'fileChanged', file: '.align/baseline.json', since: 'after-0.1.4-baseline' } },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 389 } },
    { assert: { kind: 'exists', file: '.align/version.json', equals: true } },
  ],
};
