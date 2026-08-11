// ADR 025 §7 `baseline` row: "accept (bare and --rule); show". `--rule` scopes acceptance to one
// rule id, leaving other unbaselined rules still red; bare `accept` sweeps the rest; `show` (bare
// and `--rule`-scoped) lists what's baselined.
//
// `align init --accept-existing` already baselines nest's real `arch.no-cycles:repo` violations
// (init's own cycles-first starter ruleset, real cycles at the pinned commit — see
// `upgrade-with-existing-baseline.mjs`'s header comment) — so that rule is NOT available to
// demonstrate scoping (it's baselined before this scenario ever mutates anything). Two OTHER,
// distinct new/unbaselined rule groups are added on purpose: `introduce-arch-violation` (371 real
// `arch.no-dependency:core->common` violations) and `add-no-cycles-rule` (a SECOND, duplicate
// repo-wide no-cycles rule — the DSL auto-suffixes its id to `arch.no-cycles:repo-2` on collision
// with the first, so it finds the SAME 18 real cycles under a genuinely different, still-unbaselined
// rule id).
export default {
  id: 'baseline-accept-rule-and-show',
  project: 'nest',
  description: 'align baseline accept --rule scopes to one rule id; bare accept sweeps the rest; baseline show lists both scopes.',
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 18 } },
    { mutate: 'introduce-arch-violation' },
    { mutate: 'add-no-cycles-rule' },
    { run: 'check', expect: { exit: 1 } },
    {
      run: 'baseline accept --rule arch.no-dependency:core->common',
      expect: { exit: 0, stdoutContains: "Accepted 371 violation(s) for rule 'arch.no-dependency:core->common'" },
    },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 389 } },
    // The scope held: arch.no-cycles:repo-2's 18 violations are still red, unbaselined.
    { run: 'check', expect: { exit: 1 } },
    // Bare `accept` re-processes the FULL current violation set (389 already-baselined + 18 new),
    // not just the incremental delta — "Accepted 407" is correct, not a miscount; the entry TOTAL
    // (below) is what proves the 18 new ones actually landed.
    { run: 'baseline accept', expect: { exit: 0, stdoutContains: 'Accepted 407 violation(s) into the baseline' } },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 407 } },
    { run: 'check', expect: { exit: 0 } },
    { run: 'baseline show', expect: { exit: 0, stdoutContains: '407 baselined violation(s)' } },
    {
      run: 'baseline show --rule arch.no-cycles:repo-2',
      expect: { exit: 0, stdoutContains: '18 baselined violation(s)', stdoutNotContains: 'core->common' },
    },
  ],
};
