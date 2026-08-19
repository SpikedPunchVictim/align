// LEDGER **D026**. `align check` exits 1 for a RED verdict — and until 0.2.0 commander exited 1 for a
// malformed command line too, so a typo in a CI script was indistinguishable from a repository that
// genuinely has violations. `align check --nonsuch` in a pipeline read as "your architecture is
// broken". Usage errors now exit 2.
//
// **Its own scenario rather than two more steps on `check-green-then-red`.** That scenario exists for
// ADR 025's coverage table — "`check`: exit 0 iff green" — and pinning a defect against a published
// version inside it would conflate the two jobs: a future failure there would no longer say which of
// the two it was. Same reasoning that gave `scan-history-refuses-forged-transfer` its own file.
//
// **No `align init`, deliberately.** Both commands fail (or print) during argument parsing, before any
// config is loaded, so the repository never needs to be configured — and that makes the write-set
// below an assertion in its own right: a usage error must not create, touch or stamp anything. The
// only declared paths come from the `install` step.
export default {
  id: 'usage-error-is-not-a-red-verdict',
  project: 'nest',
  description:
    'A malformed command line exits 2, not 1 — so it cannot be mistaken for `align check`\'s red verdict — while ' +
    '`--help` stays 0 (ADR 025 §7, LEDGER D026).',
  // Measured against real 0.1.4 binaries 2026-08-18, one step, right reason:
  //     step 1 (run) failed: expected exit 2, got 1
  // Step 2 (`--help` → 0) passes there, which is what makes the pin specific: the scenario fails on
  // 0.1.4 because of the defect and not because the command line is unrecognised.
  expectFailOn: ['0.1.4'],
  // ADR 026: the `install` step's two files and nothing else. A command that rejects its arguments
  // has no licence to write, and this is where that is checked rather than assumed.
  writeSet: ['package.json', 'package-lock.json'],
  steps: [
    { install: 'target' },
    // `stderrContains` as well as the exit code: an implementation that returned 2 while swallowing
    // commander's message would be worse than the defect it replaces — the user would get a distinct
    // exit code and no idea what was wrong.
    { run: 'check --nonsuch', expect: { exit: 2, stderrContains: "unknown option '--nonsuch'" } },
    // The calibration [S-05]. `--help` throws through the SAME `exitOverride` path and must stay 0,
    // so this is what stops "map every commander throw to 2" from passing the step above.
    { run: 'check --help', expect: { exit: 0, stdoutContains: '--untrusted' } },
  ],
};
