// ADR 025 §7 `export-ir`/`check` rows: "the IR round-trips; a moved IR still loads",
// "--untrusted never imports align.config.ts (ADR 014)". The strongest way to prove the
// never-executes-the-config claim is to CORRUPT `align.config.ts` (the same `corrupt-config`
// mutation `doctor-always-exits-zero.mjs` uses) after exporting the IR, and show `--untrusted`
// still works from the committed IR while a plain, trusted `check` on the SAME repo fails — if
// `--untrusted` silently fell back to executing the config, it would fail identically.
export default {
  id: 'export-ir-then-check-untrusted',
  project: 'nest',
  description:
    'align check --untrusted refuses without a committed IR, works once export-ir writes one, and never executes ' +
    'align.config.ts (ADR 014) even when a moved/custom IR path is used.',
  // ADR 026 write-set. COMMON set (see init-fresh-project.mjs's comment) plus two `export-ir`
  // outputs — `writeRulesetIr` (align-dir.ts) stamps `.align/version.json` on every call that
  // lands inside `.align/` (both do, including the `--out .align/moved-ruleset-ir.json` custom
  // path), which is why `.align/version.json` is already covered by the COMMON set and no
  // additional entry is needed for that. `check --untrusted` (with or without `--ir`) never writes.
  writeSet: [
    // ADR 029: every `align check` records what it observed in `.align/last-scan.json`. Declared
    // rather than exempted — a machine-local cache is still a path align writes into someone
    // else's repository, and ADR 026's set is what a reader consults to know that.
    '.align/last-scan.json',
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    '.align/ruleset-ir.json',
    '.align/moved-ruleset-ir.json',
  ],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { assert: { kind: 'exists', file: '.align/ruleset-ir.json', equals: false } },
    {
      run: 'check --untrusted',
      expect: { exit: 1, stderrContains: 'no committed IR ruleset found' },
    },
    { run: 'export-ir', expect: { exit: 0, stdoutContains: 'wrote' } },
    { assert: { kind: 'exists', file: '.align/ruleset-ir.json', equals: true } },
    { run: 'check --untrusted --json', expect: { exit: 0, stdoutContains: '"verdict"' } },
    // --out to a non-default path: the IR genuinely round-trips from wherever it's written, not
    // just the default location. Must run BEFORE corrupting the config below — export-ir itself
    // needs a working align.config.ts (it is the ONE command in this pipeline meant to run in a
    // trusted context, per its own description). No `exists` assert for the custom path itself —
    // `lib/capture.mjs`'s `.align/*` capture is a fixed, named catalog (baseline/generated-rules/
    // rules.lock/ruleset-ir/version.json) and deliberately does not glob arbitrary filenames; the
    // subsequent `check --untrusted --ir <path>` succeeding IS the proof the file was written
    // there and is loadable from that non-default location.
    { run: 'export-ir --out .align/moved-ruleset-ir.json', expect: { exit: 0, stdoutContains: 'moved-ruleset-ir.json' } },
    { run: 'check --untrusted --ir .align/moved-ruleset-ir.json', expect: { exit: 0 } },
    // Prove --untrusted never executes align.config.ts: corrupt it (unparseable TypeScript, the
    // same mutation doctor-always-exits-zero.mjs uses), then show --untrusted still succeeds from
    // the committed IR while a plain trusted check on the SAME repo fails — if --untrusted secretly
    // fell back to executing the config, it would fail the identical way.
    { mutate: 'corrupt-config' },
    { run: 'check --untrusted', expect: { exit: 0 } },
    { run: 'check', expect: { exit: 1 } },
  ],
};
