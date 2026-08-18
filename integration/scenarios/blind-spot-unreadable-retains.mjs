// ADR 028 Stage 5, blind-spot reason `unreadable` — and **the only scenario in this harness that
// isolates mechanism 1**, the blind-spot record itself.
//
// Everywhere else the file-existence probe (mechanism 2) is a sufficient second line: a symlinked or
// excluded directory is still readable, so the probe answers "present" and routes the orphan away
// from the content-fingerprint search on its own. Here it cannot. `chmod 000` makes the parent
// unreadable, the probe compares against the parent directory's actual entry names and so genuinely
// cannot see the file, and `fs.existsSync` would be worse than useless — it swallows the EACCES and
// reports a file inside a `chmod 000` directory as ABSENT. That is why ADR 028 needs the record AND
// the probe rather than the probe alone, and this scenario is the proof of it.
//
// **Red-before-green (ADR 025, measured in that order 2026-08-18)**: with mechanism 1 disabled and
// nothing else changed, `align check` at step 9 goes red -> GREEN at exit 0, `.align/baseline.json`
// is rewritten with both entries transferred onto the never-reviewed bait, and step 11 reports no
// retention. Mechanism 2 alone does not save it.
//
// **This scenario cannot run as root, and says so instead of passing vacuously.** `chmod` does not
// stop root: as root the directory stays readable, no blind spot exists, and every assertion below
// would be about a world the scenario failed to create. `hide-subtree-unreadable` therefore verifies
// its own precondition and throws a named error rather than failing later with a confusing retention
// assertion.
//
// Both execution paths are now non-root, which is what makes the pin real rather than aspirational:
// `.github/workflows/ci.yml` runs `node integration/run.mjs` directly on the GitHub runner, and
// `integration/Dockerfile` sets `USER node` **because of this scenario** (measured 2026-08-18: all
// 15 steps PASS inside `docker run`, where before the switch step 8 threw). LEDGER D012's lesson —
// a scenario the gate does not really execute is not calibration — applied to the container too.
// **Calibrated against the published 0.1.4, with the reason written down on purpose.**
// `expectFailOn` asserts only that the scenario did NOT pass on that target (run.mjs's calibration
// check); it cannot name a step, so a scenario failing for an unrelated reason would satisfy the
// pin while proving nothing. Measured 2026-08-18 against real 0.1.4 binaries on this exact world:
// step 9's `align check` goes red -> **GREEN at exit 0**, prints `advisory (baseline-moved): 1
// entry transferred (file moves)` and `baselined debt: 2 -> 1 (-1)`, and rewrites
// `.align/baseline.json` with one accepted entry re-homed onto the never-reviewed
// `harness-tree/bait/bait.ts` (the other stays untouched — a plain `check` never deletes). 0.1.4
// does not crash on the EACCES; it reports success while forging the transfer, which is the point.
//
// The world's config was kept to vocabulary 0.1.4 understands so that this could be a fair test,
// and that was checked rather than assumed: 0.1.4 loads it and finds both violations. This scenario
// ALSO fails on 0.1.4 later at `prune --yes` (`error: unknown option '--yes'` — the consent gate is
// 0.2.0), a wrong-reason failure that would have satisfied the pin on its own.
export default {
  id: 'blind-spot-unreadable-retains',
  project: 'nest',
  description:
    'A baselined violation under an UNREADABLE directory must be retained by `baseline prune` and must not be ' +
    'transferred onto a fingerprint-identical unreviewed violation by a plain `align check` (ADR 028 Stage 5).',
  // F3, and only added AFTER `local` went green: a red run against a published version is
  // meaningless unless the fixed side passes, since otherwise it cannot distinguish the bug from
  // a scenario that never ran. See the header for WHICH step fails on 0.1.4 and what it prints —
  // `expectFailOn` itself can only see pass/fail.
  expectFailOn: ['0.1.4'],
  // ADR 026. Same set as the symlink scenario minus the stash: nothing moves here, the directory
  // only changes mode. A mode change is not a content delta, so `harness-tree/hidden` itself needs
  // no entry beyond the two files inside it.
  tags: ['destructive'],
  writeSet: [
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'harness-forbidden/target.ts',
    'harness-tree/keep.ts',
    'harness-tree/hidden/c.ts',
    'harness-tree/hidden/d.ts',
    'harness-tree/bait/bait.ts',
    '.align/baseline.json',
    '.align/version.json',
  ],
  steps: [
    { install: 'target' },
    { mutate: 'use-hideable-subtree-world' },
    { run: 'baseline accept', expect: { exit: 0 } },
    { snapshot: 'after-accept' },
    // F6 discipline: pin the seed, so a change that stopped the rule finding anything fails LOUDLY
    // here rather than degrading every assertion below into a comparison of empty sets.
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 2 } },
    { run: 'check', expect: { exit: 0 } },
    { mutate: 'add-transfer-bait' },
    { run: 'check', expect: { exit: 1 } },
    { mutate: 'hide-subtree-unreadable' },
    // STEP 9 — THE PIN, and the arm that runs with no destructive command in sight. The advisory is
    // asserted on the reason and the path only: its message embeds the OS's own EACCES text, which
    // carries an absolute path that differs on every machine and in every working copy.
    {
      run: 'check',
      expect: {
        exit: 1,
        stdoutMatches: 'scan-blind-spot[\\s\\S]*could not be read[\\s\\S]*harness-tree/hidden',
      },
    },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
    {
      run: 'baseline prune --yes',
      expect: {
        exit: 0,
        stdoutMatches: 'Retained 2 entries[\\s\\S]*harness-tree/hidden \\(unreadable: EACCES',
        stdoutNotContains: 'Pruned 2 fixed violation',
      },
    },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 2 } },
    // Restoring the mode restores the world: the retention was about THIS scan and leaves nothing
    // sticky behind. It is also required for the run to finish at all — ADR 026's write-set check
    // walks the whole working copy afterwards and a `chmod 000` directory makes that walk throw
    // EACCES, which is how this scenario first ended in a harness ERROR with all twelve steps green.
    { mutate: 'restore-subtree-readable' },
    // Red, not green: the bait is still an unreviewed violation and always was. What has changed is
    // that the two accepted entries are observable again and no longer retained — so a regression
    // that made retention sticky would surface here.
    {
      run: 'baseline prune --yes',
      expect: { exit: 0, stdoutNotContains: 'Retained' },
    },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
  ],
};
