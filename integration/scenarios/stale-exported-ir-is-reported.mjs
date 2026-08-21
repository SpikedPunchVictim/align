// LEDGER D067 — the exported IR drifts from `align.config.ts` and nothing says so.
//
// `--untrusted` (ADR 014) reads `.align/ruleset-ir.json` instead of executing the config, and the
// documented workflow — export in a trusted checkout, `--untrusted` in CI — makes the two drift
// apart as a matter of routine rather than as an accident. It fails in both directions: a stale IR
// keeps enforcing a rule the config dropped (a false red, merely confusing) and misses one it
// gained (a false green in CI, which is the severity that matters). Reproduced on the reporter's
// fixture 08 as one tree, one moment, `align check` green and `align check --untrusted` RED, with
// neither command — nor `doctor` — mentioning that the two were reading different rules.
//
// **What makes this worth an integration scenario rather than only a unit test.** The two guards
// answer different questions and must not be conflated, and the difference is only visible when
// both run against the same real repository:
//
//   - TRUSTED (`check`, `doctor`) may load both artifacts and compare them exactly.
//   - UNTRUSTED may not execute the config — that IS the flag — so it compares a fingerprint over
//     the config SOURCE BYTES, stamped at export time. Strictly weaker, and it says so.
//
// The comment-only edit below is the sharp end of that. It moves the source bytes and NOT the
// effective ruleset, so a correct align warns on the untrusted path and stays silent on the trusted
// one. Asserting both halves of that asymmetry in one run is the whole point: assert only the
// warning and an align that warned unconditionally would pass; assert only the silence and an align
// that never warned would pass.
//
// **No `expectFailOn`.** 0.1.4 has no staleness check of any kind and no `sourceFingerprint` in its
// exported IR, so this scenario goes red against it because the FEATURE did not exist, not because
// 0.1.4 has a regression. CLAUDE.md is explicit that declaring a pin for that reason dilutes the one
// signal the pin count exists to give ("proves only that 0.1.4 is old"). It joins the three
// scenarios already undeclared for exactly this reason.
export default {
  id: 'stale-exported-ir-is-reported',
  project: 'nest',
  description:
    'A committed .align/ruleset-ir.json that no longer matches align.config.ts is reported by check and doctor; the ' +
    'untrusted path reports what a source fingerprint can support and no more; a fresh export is silent (LEDGER D067).',
  // ADR 026 write-set. COMMON set (see init-fresh-project.mjs) plus `export-ir`'s own output.
  // `check`, `check --untrusted` and `doctor` never write outside the COMMON set; the staleness
  // guards are ADVISORIES computed from files already read, and add no writer of their own.
  writeSet: [
    // ADR 029: every `align check` records what it observed in `.align/last-scan.json`.
    '.align/last-scan.json',
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    '.align/ruleset-ir.json',
  ],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    // No IR on disk yet. Not exporting is a CHOICE, not drift — warning here would fire for every
    // repository that has never used `--untrusted`, which is most of them.
    { run: 'check', expect: { exit: 0, stdoutNotContains: 'exported-ir-stale' } },
    { run: 'export-ir', expect: { exit: 0, stdoutContains: 'wrote' } },
    { assert: { kind: 'exists', file: '.align/ruleset-ir.json', equals: true } },
    // Freshly exported: BOTH paths silent. This is the calibration for every assertion below — an
    // align that emitted the advisory unconditionally would satisfy all of them and fail here.
    { run: 'check', expect: { exit: 0, stdoutNotContains: 'exported-ir-stale' } },
    { run: 'check --untrusted', expect: { exit: 0, stdoutNotContains: 'exported-ir-stale' } },
    { snapshot: 'after-export' },

    // ---- Comment-only edit: source bytes move, the effective ruleset does not. ----
    { mutate: 'append-comment-to-config' },
    // Untrusted cannot execute the config, so it can only report that the SOURCE changed — and it
    // words the advisory as exactly that claim, never as "the rules changed", which it has no way
    // to know. Over-warning is the honest direction here; the alternative is silence standing in
    // for verification [S-10].
    { run: 'check --untrusted', expect: { exit: 0, stdoutContains: 'align.config.ts has changed since' } },
    // Trusted compares the loaded rulesets and correctly says nothing: a comment is not a rule.
    { run: 'check', expect: { exit: 0, stdoutNotContains: 'exported-ir-stale' } },
    // Neither guard is a verdict change. The trusted run read the live config and its verdict is
    // correct; what is wrong is a run somewhere else, and reddening the correct run would punish
    // the person who is not making the mistake. Both `check`es above are still exit 0.
    { assert: { kind: 'fileUnchanged', file: '.align/ruleset-ir.json', since: 'after-export' } },

    // ---- Real drift: `excludes` change, which genuinely changes what `--untrusted` scans. ----
    // `excludes` rather than a rule, deliberately: excludes are exported into the IR *because* they
    // change what the untrusted scan sees, and they are the clause that caught a REAL instance in
    // align's own repository within a minute of the guard being wired up (the committed IR was
    // missing two directories). A rule-shaped drift would exercise the better-travelled half.
    //
    // The pattern this mutation adds (`harness-tree/harness-hideable/**`) matches nothing in this
    // scenario — `use-hideable-subtree-world`, which creates that subtree, is deliberately NOT run
    // here. That is a feature: `excludes` differs between the config and the IR while the scan
    // result is byte-for-byte what it was, so the advisory below cannot be an artifact of a changed
    // verdict, and the run stays green while reporting drift.
    { mutate: 'shrink-scan-with-excludes' },
    {
      run: 'check',
      expect: { exit: 0, stdoutContains: 'no longer matches align.config.ts', stdoutMatches: 'excludes\\s+differ' },
    },
    // `doctor` reports the same drift and stays advisory: exit 0 always, findings or not.
    { run: 'doctor', expect: { exit: 0, stdoutContains: 'exported-ir-stale' } },

    // ---- Re-exporting is the documented fix, and it has to actually work. ----
    // Without this step the scenario would prove align can complain, not that a user following the
    // advice reaches a quiet state — which is the difference between a guard and a nag.
    { run: 'export-ir', expect: { exit: 0, stdoutContains: 'wrote' } },
    { run: 'check', expect: { exit: 0, stdoutNotContains: 'exported-ir-stale' } },
    { run: 'check --untrusted', expect: { exit: 0, stdoutNotContains: 'exported-ir-stale' } },
  ],
};
