// ADR 028 Stage 4 (CLAUDE.md rule 2: "a new command or flag is not complete without an integration
// scenario"), exercising both halves of the retention contract against a real repository, a real
// install, and the real CLI binary.
//
// Stages 1-2 made align RETAIN a baseline entry whose file the scan could not see, instead of
// deleting it as fixed. That is only half a design. Retention with no way out is a one-way ratchet:
// a repository that permanently excludes a subtree accumulates consent records for violations that
// no longer exist, and no command will ever remove them. `--forget-unscanned <prefix>` is the
// explicit, path-scoped forfeiture that closes it.
//
// The sequence below is the whole contract in one run:
//   1. a real violation is accepted into the baseline at a path this harness owns,
//   2. that path is then excluded, so the entry becomes unobservable WITHOUT being fixed,
//   3. `align baseline prune` RETAINS it and says why (it must not silently delete it, and must not
//      silently keep it either — ADR 028 §3),
//   4. `--forget-unscanned` with a value that means "the whole repository" is REFUSED,
//   5. `--forget-unscanned <the excluded subtree>` still has to pass ADR 023's tiers — on this
//      repository's incomplete scan it is refused, and only `--allow-incomplete` lets it through,
//   6. and even then it must be CONSENTED to (ADR 006), before it forfeits exactly that entry and
//      nothing else. The headline is checked too: a run that destroys a consent decision must not
//      open with "Nothing to prune", which is the contradiction both 2026-08-17 reviewers found.
//
// No `expectFailOn: ['0.1.4']` here. 0.1.4 has neither the flag (an unrecognized option, which
// commander rejects) nor the retention behaviour, so step 3 would go red against it for a reason
// that is true but uninformative — and ADR 025's calibration is specifically about scenarios that
// pin a REGRESSION a published version demonstrably has. Stage 5 adds the calibrated cross-version
// scenarios (symlink / unreadable directory / excludes-shrink) once `local` is green.
export default {
  id: 'prune-forget-unscanned-retained',
  project: 'nest',
  description:
    'align baseline prune retains an entry whose file was excluded from the scan and names the reason; ' +
    '--forget-unscanned forfeits exactly that entry, and refuses a prefix that means the whole repository (ADR 028 Stage 4).',
  // ADR 026: the COMMON init/install set (see init-fresh-project.mjs's write-set comment) plus the
  // one source file the harness's own `add-vendored-violation` mutation creates. That last path is
  // harness scaffolding, not an align write — declared because the whole-tree invariant brackets
  // mutation steps too, and named explicitly rather than by a wildcard so an align command that ever
  // wrote into a repository's source tree would still fail this scenario.
  tags: ['destructive'],
  writeSet: [
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    'packages/core/harness-vendored/copy.ts',
  ],
  steps: [
    { install: 'target' },
    // Before `init`, so the component detection and the very first scan both see the file — the
    // entry it produces is then indistinguishable from nest's own, which is the point.
    { mutate: 'add-vendored-violation' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    { mutate: 'introduce-arch-violation' },
    { run: 'baseline accept', expect: { exit: 0 } },
    // F6 (prune-errored-run-destroys-baseline.mjs's discipline): pin the seed, so a nest pin bump or
    // a rule-evaluation change that stopped producing entries fails LOUDLY here instead of silently
    // degrading every assertion below into a comparison of empty sets. 389 is the count that
    // scenario measures at this pinned commit; this one adds exactly one file with the same import.
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 390 } },
    // The entry is now unobservable, and NOT fixed: the file and its import are untouched on disk.
    { mutate: 'exclude-vendored-subtree' },
    {
      run: 'baseline prune',
      // Both halves matter. "Retained 1 entry" is the deletion that did not happen; the excludes
      // pattern in the same line is ADR 028 §3's requirement that a retention always names its
      // reason — without it this output is indistinguishable from "nothing to prune".
      expect: { exit: 0, stdoutContains: 'Retained 1 entry', stdoutMatches: "matched the excludes pattern 'packages/core/harness-vendored/\\*\\*'" },
    },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 390 } },
    // Snapshotted HERE, not after `baseline accept`: the retaining prune above legitimately rewrites
    // the file (retention re-appends the entry it saved, so the ordering changes), and the property
    // the refusal below must satisfy is "wrote nothing", measured against the state it inherited.
    { snapshot: 'after-retaining-prune' },
    // The bare form, refused. `.` is the realistic mistake (and `--forget-unscanned "$DIR"` with an
    // unset variable is the other): it means the repository root, so honouring it would forfeit
    // every retained entry in one keystroke.
    {
      run: 'baseline prune --forget-unscanned .',
      expect: { exit: 1, stderrContains: '--forget-unscanned requires an explicit repo-relative path prefix' },
    },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-retaining-prune' } },
    // The hatch does NOT bypass ADR 023 (CLAUDE.md rule 4), and this repository proves it rather
    // than a comment asserting it: nest's own scan reports `complete: false` at the pinned commit
    // (unresolved external specifiers — see upgrade-with-existing-baseline.mjs's header for the
    // measurement), so tier 2 sees the forgotten entry as a real deletion and refuses. Measured
    // 2026-08-17: this step exited 1 with exactly this message when the scenario first ran, which is
    // how the composition got pinned here instead of being asserted.
    //
    // Note the contrast with the plain `baseline prune` above, which exits 0 on the SAME incomplete
    // scan: there, nothing was at risk (the entry was retained, not deleted), and tier 2 never
    // refuses a zero at-risk count. The flag is what turns a retention into a deletion.
    {
      run: 'baseline prune --forget-unscanned packages/core/harness-vendored',
      expect: { exit: 1, stderrContains: 'refusing to delete 1 entry' },
    },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-retaining-prune' } },
    // ADR 006's consent gate, added 2026-08-17: a forgotten entry is a deleted consent decision, so
    // the deletion is approved or it does not happen. This step passes every OTHER guard — tier 2 is
    // overridden — and is refused purely for want of consent, in a non-interactive shell where align
    // cannot ask. Silence is never consent.
    {
      run: 'baseline prune --forget-unscanned packages/core/harness-vendored --allow-incomplete',
      expect: { exit: 1, stderrContains: 'silence is never consent' },
    },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-retaining-prune' } },
    {
      run: 'baseline prune --forget-unscanned packages/core/harness-vendored --allow-incomplete --yes',
      expect: { exit: 0, stdoutContains: 'Forgot 1 retained entry', stdoutNotContains: 'Nothing to prune' },
    },
    // Exactly one entry gone: the forfeiture is scoped to its prefix, and the 389 entries nest's own
    // files produced are untouched.
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 389 } },
  ],
};
