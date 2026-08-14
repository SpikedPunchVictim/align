// A re-run of `align init` must not silently strip fields off baseline entries it did not author.
//
// THE DEFECT THIS PINS (reproduced end-to-end 2026-08-14, before any fix, on a scratch repo with
// the local binary — see the two-arm A/B below). `align baseline accept` writes a
// `contentFingerprint` (ruleId+snippet hash) on every entry it creates — `store.ts`'s `accept`.
// That field is what `applyMoves` matches on to rescue an accepted entry whose file was renamed:
// `store.ts` reads `entry.contentFingerprint`, and an entry that lacks it can NEVER match a
// candidate, so it goes straight to `unmatchedOrphans` and `align baseline prune` deletes it.
//
// `init.ts`'s baseline write rebuilds every entry from the live violation and copies forward only
// `acceptedAt`/`acceptedBy`. `contentFingerprint` and `acceptedValue` are dropped. So re-running
// `init` on a repo whose baseline came from `baseline accept` DOWNGRADES those entries — they keep
// their provenance but lose their ability to survive a rename.
//
// The two-arm A/B that proves the consequence (identical steps; the only difference is one
// `align init --accept-existing` in the middle):
//
//   arm A (no re-init): contentFingerprint present
//     -> rename the violating file -> `baseline prune` says
//        "Pruned 0 fixed violation(s) ...; 1 entry transferred (file moves)."
//        entry survives, re-homed. Next `align check`: GREEN.
//   arm B (re-init):    contentFingerprint stripped
//     -> same rename    -> `baseline prune` says
//        "Pruned 1 fixed violation(s) ...; 0 entries transferred (file moves)."
//        entry DESTROYED, exit 0. Next `align check`: RED — the violation it called "fixed" is
//        still right there, now unaccepted, and the human's consent record is gone.
//
// That is the project's severity-zero shape (CLAUDE.md rule 6): a command that destroys accepted
// debt, reports it as fixed, and exits 0. `acceptedValue` rides along on the same bug — losing it
// silently disables the `arch.metric` growth advisory for that entry (FRAGILE #8).
//
// WHY THIS SCENARIO ASSERTS ONLY THE FIELD, NOT THE PRUNE OUTCOME. The harness's mutations are
// deliberately confined to `align.config.ts` (lib/mutations.mjs's header: "never against .align/*"
// — mutating align's own output would be cheating the oracle), and none of them rename a source
// file. Reproducing arm B here would need a new source-mutating mutation whose rename must not
// also break the importers of the renamed file, which on a real repo perturbs the very scan the
// assertion depends on. The field's presence is the *cause*, is exactly as machine-checkable, and
// does not require perturbing nest's source tree — so this scenario pins the cause and the two-arm
// consequence is pinned by a unit test in core, where the rename is exact.
//
// EXPECTED TO BE RED UNTIL THE FIX LANDS, against `local` AND `0.1.4`. This scenario declares the
// CORRECT behavior (ADR 025's model), and the behavior is currently wrong in both. `expectFailOn`
// is deliberately NOT set: it means "this version is known-bad and must stay red", which is a
// claim about a PUBLISHED artifact. Adding `'0.1.4'` here is correct only once `local` is green,
// otherwise a green-on-local run could never distinguish "fixed" from "never ran".
export default {
  id: 'init-rerun-preserves-content-fingerprint',
  project: 'nest',
  description:
    'A re-run of `align init` must carry `contentFingerprint` forward on entries it did not author — dropping it ' +
    'silently makes them ineligible for move-transfer, so the next `align baseline prune` deletes them and reports ' +
    'them as fixed (exit 0).',
  // ADR 026 write-set: identical to init-fresh-project.mjs's (same command, same paths), plus
  // `baseline accept`, which writes only `.align/baseline.json` + `.align/version.json` — both
  // already in that set. `introduce-arch-violation` edits `align.config.ts`, also already in it.
  // No path is added by this scenario that `init` alone does not already touch.
  tags: ['destructive'],
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json'],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    // A real, deterministic violation (packages/core -> packages/common at the pinned commit), so
    // the entries under test are tied to real files rather than synthesized.
    { mutate: 'introduce-arch-violation' },
    { run: 'baseline accept', expect: { exit: 0 } },
    // F6 discipline: pin the seed. Verified against the pinned nest commit — 389 entries, the same
    // count prune-errored-run-destroys-baseline.mjs pins. If a nest pin bump or a rule change ever
    // made this mutation yield zero violations, this fails LOUDLY here instead of letting the
    // field assertions below degrade. (`jsonArrayEveryHasField` also refuses an empty array for
    // exactly this reason, so the two checks are belt-and-braces.)
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 389 } },
    // Establishes the premise rather than assuming it: `baseline accept` really does write the
    // field. Without this step, a future change that stopped writing it at the SOURCE would make
    // the assertion after the re-run pass for entirely the wrong reason.
    { assert: { kind: 'jsonArrayEveryHasField', file: '.align/baseline.json', field: 'contentFingerprint', equals: true } },
    { snapshot: 'after-accept' },
    // The re-run. This is the whole scenario: `init` is re-runnable by design, and a re-run must
    // not degrade entries it is merely carrying forward.
    { run: 'init --accept-existing', expect: { exit: 0 } },
    // THE ASSERTION. Currently fails: every one of the 389 entries comes back without the field.
    { assert: { kind: 'jsonArrayEveryHasField', file: '.align/baseline.json', field: 'contentFingerprint', equals: true } },
  ],
};
