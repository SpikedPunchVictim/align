// ADR 028 Stage 5, blind-spot reason `not-regular-file`.
//
// **The gap.** `readdirSync(…, { withFileTypes: true })` does not follow symlinks, so a symlinked
// directory answers false to both `isDirectory()` and `isFile()` and matches neither branch of the
// walk (`plugin-typescript/src/scanner.ts`). An entire subtree therefore vanishes from the graph
// while every one of its files is still readable at its old path — the widest distance in ADR 028's
// table between "align did not look" and "the file is gone", and the one a user is least likely to
// suspect, because nothing about the repository looks unusual.
//
// **Why the transfer arm is the point.** The two Stage 4 scenarios beside this one pin `prune`.
// Neither exercises `reconcileMoves`, which runs on **every plain `align check`** and is written
// unconditionally by `persistMovedBaseline` (`commands/check.ts`) — no destructive command, no flag,
// no completeness gate in the path. That is the severity zero of LEDGER D010 and D015, and it is why
// step 9 below is a plain `check` with a `fileUnchanged` assertion rather than a prune.
//
// **The bait is what makes that assertion real.** `add-transfer-bait` plants an UNACCEPTED violation
// whose content fingerprint is byte-identical to an accepted entry's (measured: all three files
// hash to the same `contentFingerprint`, FRAGILE #7). Without it there is no candidate for
// `reconcileMoves` to match and the assertion would hold in a world where a transfer was impossible
// — shape S-05, an assertion that passes whether or not the property does (LEDGER D006).
//
// **Measured on this world, 2026-08-18**, against the built binary: `complete: true` (so no ADR 023
// tier-2 refusal stands in for the retention), one meaningful blind spot, `align check` leaves
// `.align/baseline.json` byte-identical, and `prune --yes` retains both entries at exit 0.
//
// **Red-before-green, and what it revealed (ADR 025, measured in that order 2026-08-18).** Disabling
// mechanism 1 alone — the blind-spot record — leaves this scenario PASSING. A real symlink still
// resolves, so the file-existence probe (mechanism 2) answers "present" and routes the orphan to
// `unmatchedOrphans` on its own. The two are redundant for this reason code, which is worth knowing:
// this scenario pins the composition, not mechanism 1, and only the unreadable-directory scenario
// isolates the blind-spot record (there the probe genuinely cannot read the parent). With BOTH
// disabled it fails exactly as the defect predicts, at three steps:
//
//     step 9  expected exit 1, got 0            <- red -> GREEN on a plain `align check`
//     step 10 '.align/baseline.json' ... differs <- the consent was transferred onto the bait
//     step 11 no retention reported
//
// That is the severity zero in its purest form: no destructive command, no flag, exit 0.
//
// **Calibrated against the published 0.1.4, and the reason is written down on purpose.**
// `expectFailOn` asserts only that the scenario did NOT pass on that target (run.mjs's calibration
// check); it cannot name a step, so a scenario that failed for an unrelated reason would satisfy
// the pin while proving nothing. Measured 2026-08-18 against real 0.1.4 binaries on this exact
// world: step 9's `align check` goes red -> **GREEN at exit 0**, prints `advisory
// (baseline-moved): 1 entry transferred (file moves)` and `baselined debt: 2 -> 1 (-1)`, and
// rewrites `.align/baseline.json` with one accepted entry re-homed onto the never-reviewed
// `harness-tree/bait/bait.ts` (the other stays untouched — a plain `check` never deletes). That is
// the defect, failing for the right reason.
//
// Two things had to be true for that to be a fair test, and both were checked rather than assumed:
// the world's config uses only vocabulary 0.1.4 understands (verified by running 0.1.4 against it
// — it loads and finds both violations), and the scenario reaches step 9 at all. It ALSO fails on
// 0.1.4 later at `prune --yes` (`error: unknown option '--yes'` — the consent gate is 0.2.0), a
// wrong-reason failure that would have satisfied the pin on its own. Hence this note.
export default {
  id: 'blind-spot-symlink-retains',
  project: 'nest',
  description:
    'A baselined violation under a SYMLINKED directory must be retained by `baseline prune` and must not be ' +
    'transferred onto a fingerprint-identical unreviewed violation by a plain `align check` (ADR 028 Stage 5).',
  // F3, and only added AFTER `local` went green: a red run against a published version is
  // meaningless unless the fixed side passes, since otherwise it cannot distinguish the bug from
  // a scenario that never ran. See the header for WHICH step fails on 0.1.4 and what it prints —
  // `expectFailOn` itself can only see pass/fail.
  expectFailOn: ['0.1.4'],
  // ADR 026. No `align init` runs (the config is written by a mutation), so there is no CLAUDE.md
  // and no .gitignore in the set — only the install's two files, the tree this scenario's own
  // mutations own, and the two `.align/` artifacts `baseline accept` writes. `harness-stash/**` is
  // declared because the symlink mutation MOVES the subtree there: both the disappearance from
  // `harness-tree/hidden/` and the appearance under `harness-stash/` are deltas.
  tags: ['destructive'],
  writeSet: [
    // ADR 029: every `align check` records what it observed in `.align/last-scan.json`. Declared
    // rather than exempted — a machine-local cache is still a path align writes into someone
    // else's repository, and ADR 026's set is what a reader consults to know that.
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
    'harness-stash/hidden/c.ts',
    'harness-stash/hidden/d.ts',
    '.align/baseline.json',
    '.align/version.json',
  ],
  steps: [
    { install: 'target' },
    { mutate: 'use-hideable-subtree-world' },
    // Real violations, found by a real rule, accepted as real debt — the entries protected below are
    // genuine consent decisions, not hand-written JSON.
    { run: 'baseline accept', expect: { exit: 0 } },
    { snapshot: 'after-accept' },
    // F6 discipline (prune-errored-run-destroys-baseline.mjs): pin the seed, so a change that stopped
    // the rule finding anything fails LOUDLY here instead of degrading every assertion below into a
    // comparison of empty sets.
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 2 } },
    // Green before anything is hidden: the baseline covers every violation, so whatever happens
    // after the mutations is caused by them and nothing else.
    { run: 'check', expect: { exit: 0 } },
    // The bait: a third violation, never reviewed, fingerprint-identical to the two accepted ones.
    // `check` is now legitimately red, and stays red for the rest of the scenario — a green here
    // would mean the bait had been silently pre-accepted, which is the defect itself.
    { mutate: 'add-transfer-bait' },
    { run: 'check', expect: { exit: 1 } },
    { mutate: 'hide-subtree-as-symlink' },
    // STEP 9 — THE PIN. A plain `align check`: no destructive command, no flag. `reconcileMoves`
    // sees two orphaned entries and a fingerprint-identical live violation, and must decline the
    // match. Asserted on the advisory's two durable halves (the reason and the path) rather than the
    // full sentence — a scenario that breaks on prose editing trains people to update assertions
    // without reading them (that happened once already, to partial-checkout-retains).
    {
      run: 'check',
      expect: {
        exit: 1,
        stdoutMatches: 'scan-blind-spot[\\s\\S]*not a regular file[\\s\\S]*harness-tree/hidden',
      },
    },
    // The transfer that must not have happened. `check` writes the baseline unconditionally when
    // `reconcileMoves` returns anything, so byte-identity here is the whole assertion: a forged
    // transfer would have rewritten these entries onto `harness-tree/bait/bait.ts`, carrying
    // `acceptedAt`/`acceptedBy` onto a violation nobody reviewed.
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
    // And the prune arm, on a `complete: true` scan — so this is the exit-0 form of the defect, the
    // one ADR 023's tiers cannot catch because nothing errored and nothing was incomplete.
    {
      run: 'baseline prune --yes',
      expect: {
        exit: 0,
        stdoutMatches: 'Retained 2 entries[\\s\\S]*harness-tree/hidden \\(not a regular file',
        stdoutNotContains: 'Pruned 2 fixed violation',
      },
    },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 2 } },
  ],
};
