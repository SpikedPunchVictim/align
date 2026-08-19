// ADR 030's observable contract, end to end: when another align holds `.align/`, a writing command
// **refuses and loses nothing** — it never writes a stale snapshot over what the other one recorded.
//
// **Why this scenario exists at all.** ADR 030's lock-and-token mechanism has 21 unit tests and, until
// now, zero end-to-end coverage: `runScenario` is a strictly sequential loop with no background-step
// primitive, so no scenario had ever put two aligns in the same repository at the same time. That is
// the second half of a blind spot LEDGER D030 exposed — no instrument here ran a command twice and
// asked whether the answer was stable, and none ran two commands at once at all.
//
// **How it is deterministic without concurrency.** The lock IS align's representation of another align
// holding the repository (`writeBaseline` is the only taker). Planting a live one is a faithful
// stand-in for the process that would have taken it, and it is *better* than real concurrency here,
// because the outcome does not depend on winning a scheduling race — a genuinely concurrent scenario
// would be flaky in exactly the way a release gate must not be. ADR 030 holds the lock only around the
// commit (a token compare, a write, a rename), so a real interleave is a window of milliseconds.
//
// **What this deliberately does NOT cover, stated so nobody reads it as more than it is.** The
// LOST-UPDATE arm — read baseline, another align writes, this one writes back over it with a stale
// token — needs a true interleave inside one command and stays unit-only
// (`baseline-concurrent-write.test.ts`). This scenario covers the LOCK arm: contention is detected,
// the command refuses, and the repository is byte-identical afterwards.
export default {
  id: 'concurrent-align-refuses-rather-than-loses',
  project: 'nest',
  description:
    'While another align holds the `.align/` lock, a writing command refuses loudly and leaves the baseline ' +
    'byte-identical; once the lock is released the same command succeeds (ADR 030).',
  tags: ['destructive'],
  // ADR 026. The COMMON `init` set plus `install`'s two files. `.align/.lock` is NOT declared: the
  // mutation creates it and the release mutation removes it, so it is absent at the end exactly as it
  // was at the start — and if a future align ever failed to leave it that way, the write-set catches
  // it without this scenario having to assert anything.
  writeSet: [
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    '.align/last-scan.json',
  ],
  steps: [
    { install: 'local' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    // Real debt for the contended command to accept, so the refusal below is refusing to write
    // something rather than refusing to write nothing.
    { mutate: 'introduce-arch-violation' },
    { run: 'check', expect: { exit: 1 } },
    { snapshot: 'before-contention' },

    // Another align, mid-write, on another machine sharing `.align/`. Recent enough not to be stale,
    // so it is genuinely held rather than breakable — the case `stale-foreign-lock-clears` is the
    // mirror image of.
    { mutate: 'plant-live-foreign-lock' },

    // THE PIN. Waits the full timeout, then refuses. `stderrContains` names the CONTENTION rather than
    // matching the whole sentence: an exit 1 alone would also be satisfied by a command that failed for
    // any other reason, which is how a scenario ends up asserting nothing.
    {
      run: 'baseline accept',
      expect: { exit: 1, stderrContains: 'Another align process is writing to this repository' },
    },
    // NOTHING WAS LOST — the whole point of ADR 030. A refusal that still wrote a partial or stale
    // baseline would satisfy the exit code above and be the defect the ADR exists to prevent.
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'before-contention' } },

    // The other align finishes and releases. Calibration [S-05]: without this, every assertion above
    // would hold in a world where `baseline accept` simply never worked.
    { mutate: 'remove-align-lock' },
    { run: 'baseline accept', expect: { exit: 0 } },
    { assert: { kind: 'fileChanged', file: '.align/baseline.json', since: 'before-contention' } },
  ],
};
