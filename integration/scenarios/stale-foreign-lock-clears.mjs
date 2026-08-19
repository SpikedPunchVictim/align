// LEDGER **D029**. `.align/.lock` (ADR 030) is created and deleted inside a single command — so a copy
// of one in git is, by definition, a copy of a lock somebody lost. It was gitignored NOWHERE, and
// `isBreakable` refused to break a holder from another host **at any age**, on the reasoning that a
// foreign pid cannot be liveness-checked. Both halves were individually defensible and together they
// were a repository-wide outage: one `git add -A` after a SIGKILL committed a foreign-host lock that
// then blocked every writing align command, on every teammate's machine and every CI run, forever.
//
// The refutation was already written two lines below the bug, in the same function — the
// unidentifiable-holder branch says in as many words that for a file align creates, owns and deletes,
// never-break is the UNSAFE direction. That is [S-12] recurring inside the function whose comment
// refutes it.
//
// **This scenario needed the harness to learn to see the file.** `.lock` was absent from
// `ALIGN_DIR_FILES` (`lib/capture.mjs`), so no capture, no snapshot and no write-set could observe it
// — the one `.align/` file whose presence after a command is always a defect was the one the
// instrument was blind to. Adding it makes "no command leaves a lock behind" a property every scenario
// now asserts for free, without any of them declaring it.
export default {
  id: 'stale-foreign-lock-clears',
  project: 'nest',
  description:
    'A stale `.align/.lock` from another machine — the shape that arrives through git — must not block every ' +
    'writing command forever (ADR 030, LEDGER D029).',
  // No `expectFailOn`: this installs `local` only. The pre-fix behaviour is measured in
  // `packages/cli/test/align-lock.test.ts`, where the old rule is reproduced directly.
  tags: ['destructive'],
  // ADR 026. `init --accept-existing` contributes the COMMON set; `baseline accept` rewrites
  // `.align/baseline.json` and `.align/version.json`, both already there. `.align/.lock` is NOT
  // declared, deliberately — the mutation creates it and align must remove it, so the file is absent
  // at the end exactly as it was at the start. If the break ever regresses, the leftover lock becomes
  // an undeclared path and this scenario fails on the write-set rather than on a step, which is the
  // stronger signal.
  writeSet: [
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    // ADR 029: the closing `align check` records what it observed. Declared rather than exempted — a
    // machine-local cache is still a path align writes into someone else's repository.
    '.align/last-scan.json',
  ],
  steps: [
    { install: 'local' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    // The OTHER half of the fix — `init` writing `.align/.lock` into `.gitignore`, which is what stops
    // this recurring — is NOT asserted here: the harness captures only `align.config.ts`, `CLAUDE.md`
    // and `.align/*`, so `.gitignore` content is out of its reach, and inventing a `fileContains` kind
    // for one use would be more machinery than the claim is worth. It is covered by
    // `packages/cli/test/init-gitignore.test.ts`, which is driven off `ALIGN_LOCAL_GITIGNORE_ENTRIES`
    // and therefore cannot go stale when that list changes. Said here so the gap is a decision rather
    // than an oversight.
    { mutate: 'plant-foreign-host-lock' },
    // THE PIN. Before the fix this waited the full 10s timeout and exited 1 — every time, forever.
    // The stderr assertion is what makes it a break rather than a coincidence: a run that simply
    // ignored the lock file would also exit 0.
    {
      run: 'baseline accept',
      expect: { exit: 0, stderrContains: 'it is on another machine' },
    },
    // ...and the lock is gone, so the next command does not repeat the wait. `exists: false` rather
    // than a write-set entry: this asserts the END state directly, where the write-set only proves
    // the file is not a NET delta.
    { assert: { kind: 'exists', file: '.align/.lock', equals: false } },
    // The repository is still usable — the break did not corrupt what it was protecting.
    { run: 'check', expect: { exit: 0 } },
  ],
};
