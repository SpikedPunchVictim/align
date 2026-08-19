// ADR 025 Tier-1 #3 (ADR 023 tier 2, exercised for the first time by this harness — increment 1
// only ever built tier 1, the errored-run refusal). Runs against `nest-incomplete`
// (`projects/nest-incomplete.mjs`) — the SAME pinned nest commit as `nest`, with its own
// dependencies deliberately never installed, so `align check` reports `complete: false` (verified
// empirically, 2026-08-10: 1250 unresolved external specifiers across 744 files — dramatically more
// than the 48/43 the fully-installed `nest` project itself already shows, see
// `upgrade-with-existing-baseline.mjs`'s header comment for that smaller, separate finding).
//
// **Why the baseline entry count is unaffected by the missing dependencies.** `introduce-arch-
// violation`'s rule (`packages/core` cannotDependOn `packages/common`) and `init`'s own no-cycles
// rule are both evaluated over REPO-INTERNAL, relative-path imports — resolved directly against the
// filesystem, never through `node_modules`. Verified empirically: the SAME 389-entry baseline
// (371 `arch.no-dependency:core->common` + 18 `arch.no-cycles:repo`) forms here as on the
// fully-installed `nest` project. Missing dependencies affect EXTERNAL edges, not these internal
// ones — so a plain re-scan finds nothing orphaned (`baselineDebt: {previous: 389, current: 389,
// delta: 0}`) and `align baseline prune` has nothing to refuse. To exercise the refusal for real,
// this scenario retires the introduced rule (`remove-arch-violation-rule`) before pruning — the
// same "a rule was removed" construction `upgrade-with-existing-baseline.mjs` uses, clearly a
// CONSTRUCTED at-risk item, not a completeness-driven one: the 371 `core->common` entries become
// genuinely orphaned because the rule that produced them no longer runs, which `align baseline
// prune` must refuse to delete anyway while the scan remains incomplete (ADR 023's point precisely:
// an absent violation on an incomplete scan is unverified, whatever the reason it went absent).
// `--yes` on the reconciling step (added 2026-08-18): every deletion now passes ADR 006's consent
// gate, and this harness spawns with piped stdio (`lib/exec.mjs`), so there is no terminal to ask.
// Without it this scenario went red on a refusal that is correct behaviour — found by review, not by
// the gate command, because this scenario declares `project: 'nest-incomplete'` and the documented
// gate (`node integration/run.mjs --targets local`) defaults to `--project nest` and never runs it.
// See docs/adr/defects/LEDGER.md D012.
export default {
  id: 'prune-incomplete-scan-requires-allow-incomplete',
  project: 'nest-incomplete',
  description:
    'align baseline prune on a complete:false scan refuses to delete without --allow-incomplete and leaves the ' +
    'baseline unchanged; with the flag it proceeds (ADR 023 tier 2).',
  // Verified empirically (2026-08-10): a real 0.1.4 has no ADR 023 tier-2 refusal at all — `baseline
  // prune` deletes the 371 orphaned entries unconditionally and `--allow-incomplete` isn't even a
  // recognized flag. Real, reproducible red on a published version, matching the "the harness must
  // be able to fail" discipline `prune-errored-run-destroys-baseline.mjs` established for tier 1.
  expectFailOn: ['0.1.4'],
  // ADR 026: `baseline prune` again (ADR 023 tier 2 this time), same reasoning as
  // prune-errored-run-destroys-baseline.mjs — the refusal path writes nothing, `--allow-incomplete`
  // writes only `.align/baseline.json`/`.align/version.json`, already in the COMMON set (see
  // init-fresh-project.mjs's write-set comment). Runs against the `nest-incomplete` project, which
  // uses the SAME relative paths as `nest` (projects/nest-incomplete.mjs: "the SAME repo state").
  tags: ['destructive'],
  // `.align/last-scan.json`: every `align check` records what it observed (ADR 029). Declared
  // rather than exempted — a machine-local cache is still a path align writes into someone
  // else's repository, and ADR 026's set is what a reader consults to know that.
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json', '.align/last-scan.json'],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { mutate: 'introduce-arch-violation' },
    { run: 'baseline accept', expect: { exit: 0, stdoutContains: 'Accepted 389 violation(s)' } },
    { snapshot: 'after-accept' },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 389 } },
    // Confirms this project variant genuinely produces an incomplete scan, before relying on that
    // fact for the refusal below — the same "seed pinned, don't assume" discipline
    // `prune-errored-run-destroys-baseline.mjs` uses for its own count.
    { run: 'check --json', expect: { exit: 0, stdoutContains: '"complete": false' } },
    { mutate: 'remove-arch-violation-rule' },
    {
      run: 'baseline prune',
      expect: { exit: 1, stderrContains: 'refusing to delete 371 entries' },
    },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
    {
      run: 'baseline prune --allow-incomplete --yes',
      expect: { exit: 0, stdoutContains: 'Pruned 371 fixed violation(s)' },
    },
    { assert: { kind: 'fileChanged', file: '.align/baseline.json', since: 'after-accept' } },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 18 } },
  ],
};
