// ADR 028 Stage 5, blind-spot reason `excluded` — the excludes-shrink case: the scan's scope
// narrows under a baseline that was accepted while it was wider. Nothing about the files changes;
// only align's view of them does. This is the commonest way a real user reaches ADR 028's inference,
// because adding an `excludes` pattern feels like a configuration edit rather than a destructive
// one.
//
// **Not a duplicate of `prune-forget-unscanned-retained`.** That scenario shares this reason code and
// nothing else. It runs against nest, whose scan is `complete: false` at the pinned commit, so ADR
// 023 tier 2 refuses first and the exit-0 path is never reached; and it pins the `--forget-unscanned`
// hatch, which is a `prune` concern. This one runs against a `complete: true` world, so the deletion
// is genuinely reachable at exit 0, and it pins the `align check` transfer arm — the one that needs
// no destructive command and that neither Stage 4 scenario exercises (LEDGER D010, D015).
//
// **The advisory is deliberately silent here, and that is asserted rather than assumed.**
// `ADVISORY_BLIND_SPOT_REASONS` (`core/src/gates/advisories.ts`) omits `excluded` and
// `default-excluded-dir` on the stated grounds that the user authored those patterns themselves.
// Verified against the built binary 2026-08-18: `align check` prints no `scan-blind-spot` advisory
// in this state. So the reason reaches the user through `prune`'s retention line and only there,
// which is exactly why step 11 asserts the pattern text — it is the single place a user is told
// which pattern hid their accepted entry.
//
// **Red-before-green (ADR 025, measured in that order 2026-08-18)**: with mechanisms 1 and 2 both
// disabled, `align check` at step 9 goes red -> GREEN at exit 0 and the entries are transferred onto
// the unreviewed bait. As with the symlink case the two mechanisms are redundant for this reason
// code — an excluded directory is still perfectly readable, so the file-existence probe answers
// "present" on its own; only the unreadable-directory scenario isolates the blind-spot record.
//
// **Calibrated against the published 0.1.4, with the reason written down on purpose.**
// `expectFailOn` asserts only that the scenario did NOT pass on that target (run.mjs's calibration
// check); it cannot name a step, so a scenario failing for an unrelated reason would satisfy the
// pin while proving nothing. Measured 2026-08-18 against real 0.1.4 binaries on this exact world:
// step 9's `align check` goes red -> **GREEN at exit 0**, prints `advisory (baseline-moved): 1
// entry transferred (file moves)` and `baselined debt: 2 -> 1 (-1)`, and rewrites
// `.align/baseline.json` with one accepted entry re-homed onto the never-reviewed
// `harness-tree/bait/bait.ts` (the other stays untouched — a plain `check` never deletes).
//
// The world's config was kept to vocabulary 0.1.4 understands so that this could be a fair test,
// and that was checked rather than assumed: 0.1.4 loads it and finds both violations. This
// scenario ALSO fails on 0.1.4 later at `prune --yes` (`error: unknown option '--yes'` — the
// consent gate is 0.2.0), a wrong-reason failure that would have satisfied the pin on its own.
export default {
  id: 'blind-spot-excludes-shrink-retains',
  project: 'nest',
  description:
    'Narrowing the scan with a new `excludes` pattern must retain the baselined entries it hides and must not ' +
    'transfer them onto a fingerprint-identical unreviewed violation on a plain `align check` (ADR 028 Stage 5).',
  // F3, and only added AFTER `local` went green: a red run against a published version is
  // meaningless unless the fixed side passes, since otherwise it cannot distinguish the bug from
  // a scenario that never ran. See the header for WHICH step fails on 0.1.4 and what it prints —
  // `expectFailOn` itself can only see pass/fail.
  expectFailOn: ['0.1.4'],
  // ADR 026. `align.config.ts` is in the set because the mutation appends the `excludes` export to
  // it — the config is this scenario's instrument, not align's output, and it is declared for the
  // same reason the source files are.
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
    { mutate: 'shrink-scan-with-excludes' },
    // STEP 9 — THE PIN. Still red (the bait is still an unreviewed violation), and — the assertion
    // that matters — the baseline is untouched. No advisory is asserted here: see the header, this
    // reason code deliberately produces none.
    { run: 'check', expect: { exit: 1 } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
    // The one place the user learns which pattern hid their entries.
    {
      run: 'baseline prune --yes',
      expect: {
        exit: 0,
        stdoutMatches: "Retained 2 entries[\\s\\S]*matched the excludes pattern 'harness-tree/hidden/\\*\\*'",
        stdoutNotContains: 'Pruned 2 fixed violation',
      },
    },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 2 } },
  ],
};
