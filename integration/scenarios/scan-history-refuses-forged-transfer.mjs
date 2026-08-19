// LEDGER **D015**, closed — the last open severity zero, reproduced and refused against real
// binaries on a real project.
//
// **The defect.** `reconcileMoves` runs on every plain `align check` and matches an orphaned baseline
// entry to a live violation by content fingerprint (FRAGILE #7). Delete an accepted file while a
// content-identical, never-reviewed violation sits elsewhere in the tree, and align calls it a rename
// and moves the human's `acceptedAt`/`acceptedBy` onto the violation nobody looked at. The repository
// goes red -> **green**, `persistMovedBaseline` writes it to disk, and the command exits 0. No
// destructive subcommand, no flag, no completeness gate stands in front of any of it.
//
// **Why the existing guards all decline here**, and why each is held still on purpose:
//   - mechanism 1 (blind-spot record): nothing is excluded, symlinked or unreadable — no record.
//   - mechanism 2 (file-existence probe): the file is genuinely gone.
//   - mechanism 3 / ADR 006's whole-directory exception: `d.ts` survives, so `harness-tree/hidden/`
//     still produces an observed file and the directory test does not fire. That survivor is the
//     difference between this scenario and `partial-checkout-retains`, and without it this would pass
//     without ADR 029 existing at all [S-05].
//
// **What closes it.** ADR 029 §6: before transferring, ask whether the PREVIOUS scan already reported
// that violation at that path. Step 7's `check` is what puts the bait into `.align/last-scan.json`;
// step 9's `check` is what consults it. So this scenario also pins the whole ADR 029 loop end to end
// — a wiring mistake anywhere between `openScanHistory`, `createOrchestrator` and
// `persistScanObservation` fails here even with every unit test green.
//
// **Step 7 is load-bearing and is not a duplicate of step 5.** Remove it and the record never sees the
// bait, `wasViolationObservedAt` answers `known: true, value: false`, and the transfer proceeds — 
// correctly, because that is then indistinguishable from a rename. The mechanism needs two scans by
// construction, which is also the honest statement of what it does NOT cover: a first run on a fresh
// checkout has no record, and D015 is still reachable there.
export default {
  id: 'scan-history-refuses-forged-transfer',
  project: 'nest',
  description:
    'A plain `align check` must not transfer an accepted entry onto a never-reviewed violation that the ' +
    'previous scan already reported at that path (ADR 029 §6, LEDGER D015).',
  // Calibration, MEASURED against real 0.1.4 binaries on 2026-08-18, not assumed. 0.1.4 has no scan
  // history, so step 9's `check` transfers and reports:
  //
  //     step 9  expected exit 1, got 0; expected stdout NOT to contain "transferred (file moves)"
  //     step 10 '.align/baseline.json' ... differs
  //
  // and the preserved working copy holds the forgery itself — the two accepted entries are
  // `harness-tree/hidden/d.ts` and **`harness-tree/bait/bait.ts`, `acceptedBy: manual`**, a human's
  // consent sitting on a violation nobody ever reviewed, at exit 0. Both failures are the reason this
  // scenario exists, which matters because `expectFailOn` can only see pass/fail and would be equally
  // satisfied by a scenario that died at step 0. The world's config uses only vocabulary 0.1.4
  // understands (the same world `blind-spot-symlink-retains` calibrates on) and no 0.2.0-only flag
  // appears in any step, so there is no wrong-reason failure available to satisfy the pin — checked by
  // reading the run's own step log, where every step up to 9 succeeded.
  expectFailOn: ['0.1.4'],
  tags: ['destructive'],
  // ADR 026. No `align init` runs — the config comes from a mutation — so there is no CLAUDE.md and no
  // .gitignore here. `harness-tree/hidden/c.ts` is in the set because this scenario DELETES it, which
  // is a delta like any other; the harness's write-set does not distinguish creating a path from
  // removing one, and it should not.
  writeSet: [
    // ADR 029: every `align check` records what it observed. Declared rather than exempted — a
    // machine-local cache is still a path align writes into someone else's repository.
    '.align/last-scan.json',
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'harness-forbidden/target.ts',
    'harness-tree/keep.ts',
    'harness-tree/hidden',
    'harness-tree/hidden/c.ts',
    'harness-tree/hidden/d.ts',
    'harness-tree/bait/bait.ts',
    '.align/baseline.json',
    '.align/version.json',
  ],
  steps: [
    { install: 'target' },
    { mutate: 'use-hideable-subtree-world' },
    // Real violations, found by a real rule, accepted as real debt — the consent this scenario
    // protects is a genuine decision, not hand-written JSON.
    { run: 'baseline accept', expect: { exit: 0 } },
    { snapshot: 'after-accept' },
    // Pin the seed, so a change that stopped the rule finding anything fails LOUDLY here instead of
    // degrading every assertion below into a comparison of empty sets.
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 2 } },
    { run: 'check', expect: { exit: 0 } },

    // The bait: a third violation, never reviewed, fingerprint-identical to the two accepted ones.
    { mutate: 'add-transfer-bait' },
    // STEP 7. Red because the bait is unbaselined — and, the reason this step exists, the run that
    // records the bait as observed-violating in `.align/last-scan.json`.
    { run: 'check', expect: { exit: 1 } },

    // The accepted file disappears while its sibling stays. This is D015's recipe exactly.
    { mutate: 'delete-one-accepted-file' },
    // STEP 9 — THE PIN. Still red: the bait is still an unreviewed violation and did not inherit
    // anyone's acceptance. On 0.1.4 this line is `exit: 0`. `stdoutNotContains` names the transfer
    // report specifically, because "still red" alone would also be satisfied by a run that transferred
    // one entry and left the other orphan red.
    {
      run: 'check',
      expect: {
        exit: 1,
        stdoutNotContains: 'transferred (file moves)',
      },
    },
    // The consent stayed where the human put it. `check` rewrites the baseline unconditionally when
    // `reconcileMoves` returns anything, so byte-identity here IS the assertion — a forged transfer
    // would have re-homed `harness-tree/hidden/c.ts`'s entry onto `harness-tree/bait/bait.ts`,
    // carrying `acceptedAt`/`acceptedBy` with it. Nothing was deleted either: `reconcileMoves` leaves
    // an unmatched orphan alone, so the entry is retained at a path that no longer exists — the loud,
    // recoverable direction ADR 006's asymmetry chose.
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 2 } },
  ],
};
