// ADR 028 Stage 4's regression pin for the severity zero, and the only scenario in this harness that
// can produce it (CLAUDE.md rule 6: a command that destroys data and exits 0 outranks everything).
//
// **The defect this exists to stop from coming back.** Reproduced 2026-08-17 by two independent
// reviewers, and again by hand against the built binary: with a component's directory absent from
// the working tree, `align baseline prune` printed "Pruned 1 fixed violation(s)", exited 0, and left
// `.align/baseline.json` as `[]`. Every guard passed it — the scan was `complete: true` so ADR 023
// tier 2 was silent, no gate errored so tier 1 was silent, no blind spot covered the path because a
// directory that is not there produces nothing to record, and the existence probe correctly answered
// "absent" because the file genuinely was. Absence from disk had become evidence of deletion, which
// is the exact inference ADR 028 exists to refuse.
//
// **Why no other scenario could have caught it.** The two prune scenarios beside this one make files
// unobservable by EXCLUDING them, which records a blind spot and therefore RETAINS — the opposite
// state. Reaching this defect needs the files genuinely gone, and deleting one of nest's own package
// directories would put thousands of paths into ADR 026's before/after delta. So the mutations here
// give the working copy a one-component world it owns end to end and then remove it, which is a
// partial checkout in miniature: nothing recorded, nothing on disk, no ancestor to blame.
//
// **What now catches it** is mechanism 3 (`scan-blind-spot-retention.ts`): a real deletion leaves its
// siblings behind, a missing tree takes them all with it, so an entry whose directory produced no
// observed file at all is retained rather than forfeited. A whole-run refusal keyed on component
// grounding (a "floor") was tried first and removed the same day — it was a per-run guard against
// per-entry damage, so it missed this very case, and its non-overridable refusal trapped legitimate
// repositories. **Verified red-before-green in that order (ADR 025), 2026-08-17**: with mechanism 3
// disabled and nothing else changed, this scenario fails at three steps. Worth reading precisely,
// because the shape differs from the hand reproduction — on nest's `complete: false` scan the DIRECT
// prune is refused by ADR 023 tier 2 rather than exiting 0, and the destruction surfaces one step
// later at `upgrade --yes --allow-incomplete`, which overrides tier 2 and deletes the entry
// (`fileUnchanged` then fails). So this scenario pins "the entry is not retained" and catches the
// data loss through the delegated path; the exit-0 form of the same defect needs a `complete: true`
// scan and is pinned by `prune-retention-and-consent.test.ts` against a fixture.
//
// **`--from 0.1.4` rather than a real `install: '0.1.4'`**: this scenario needs a config using
// today's DSL, so seeding it under a published 0.1.4 would test whether 0.1.4 understood that key,
// which is not the question. `--from` is `options.from ?? stamp?.alignVersion` (`upgrade.ts`), so it
// selects the same non-empty migration range a missing stamp would and drives the full reconciliation
// path — covering the explicit `--from` route as a side effect.
export default {
  id: 'partial-checkout-retains',
  project: 'nest',
  description:
    'A baselined violation whose whole directory is absent from the working tree must be RETAINED, not ' +
    'pruned as fixed at exit 0 — directly via `baseline prune` and via the `align upgrade` path that delegates to it (ADR 028 Stage 4).',
  // ADR 026. No `align init` runs here (the config is written by a mutation), so there is no
  // CLAUDE.md and no .gitignore in the set — only the install's two files, the config and source
  // tree this scenario's own mutations own, and the two `.align/` artifacts `baseline accept` writes.
  // The `harness-tree/*` paths are declared because they are both CREATED and DELETED within the run,
  // and both directions are deltas.
  tags: ['destructive'],
  writeSet: [
    // ADR 029: every `align check` records what it observed in `.align/last-scan.json`. Declared
    // rather than exempted — a machine-local cache is still a path align writes into someone
    // else's repository, and ADR 026's set is what a reader consults to know that.
    '.align/last-scan.json',
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'harness-tree/a.ts',
    'harness-tree/b.ts',
    '.align/baseline.json',
    '.align/version.json',
  ],
  steps: [
    { install: 'local' },
    { mutate: 'use-single-component-tree' },
    // A real cycle, found by a real rule, accepted as real debt — the entry being protected below is
    // a genuine consent decision, not hand-written JSON.
    { run: 'baseline accept', expect: { exit: 0 } },
    { snapshot: 'after-accept' },
    // F6 discipline (prune-errored-run-destroys-baseline.mjs): pin the seed, so a change that stopped
    // the cycle rule finding anything fails LOUDLY here instead of degrading every assertion below
    // into a comparison of empty sets.
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 1 } },
    // Green before the deletion: the baseline covers the only violation, so whatever happens next is
    // caused by the missing tree and nothing else.
    { run: 'check', expect: { exit: 0 } },
    { mutate: 'delete-single-component-tree' },
    // STEP 6 — THE PIN. `--yes` supplies consent so the ADR 006 gate cannot be what produces the
    // exit code: this step must pass or fail on the retention decision alone. Before mechanism 3 this
    // printed "Pruned 1 fixed violation(s)" and exited 0.
    {
      run: 'baseline prune --yes',
      expect: {
        exit: 0,
        stdoutContains: 'Retained 1 entry',
        // ADR 028 §3 — the reason is printed, never just the count, and it names the directory,
        // which is the fact separating a missing tree from a deleted file. Asserted on the two
        // durable halves (the directory name, and the claim being made about it) rather than the
        // full sentence: this assertion went stale once already when review corrected the message
        // from "observed no file under it" to "absent from this working tree", and a scenario that
        // breaks on prose editing trains people to update assertions without reading them.
        // ONE regex covering both durable facts, because `expect` keys are a plain object literal:
        // a second `stdoutContains` here would be a duplicate key, JS would keep only the last, and
        // 'Retained 1 entry' would silently stop being asserted. That is shape S-05 (a test passing
        // for the wrong reason) and it was written, then caught, while fixing this very step.
        // Second half pins the remedy: a retention the user cannot act on is a dead end, and this is
        // the only place the escape hatch is offered for this arm.
        stdoutMatches: 'harness-tree \\(that whole directory is absent[\\s\\S]*--forget-unscanned harness-tree',
        stdoutNotContains: 'Pruned 1 fixed violation',
      },
    },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 1 } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
    // The delegated path inherits the same protection: `upgrade` computes its own prune preview and
    // then calls `baselinePrune`, so retention has to hold through both. `--yes --allow-incomplete`
    // are the two strongest overrides a user can pass; neither is permitted to turn a retention into
    // a deletion, because neither is evidence about a directory align never saw.
    { run: 'upgrade --from 0.1.4 --yes --allow-incomplete', expect: { exit: 0 } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
    // Restoring the tree restores the world — the retention is about THIS scan and leaves nothing
    // sticky behind once the checkout is whole again.
    { mutate: 'use-single-component-tree' },
    { run: 'check', expect: { exit: 0 } },
  ],
};
