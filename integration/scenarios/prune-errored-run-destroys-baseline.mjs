// ADR 025 §5, "the harness must be able to fail" — the highest-priority scenario in increment 1.
//
// Real bug, fixed on this branch (commit a0d2baa, and 0db10d7 before it): `align baseline prune`
// on an ERRORED run destroyed every accepted baseline entry while printing "Pruned N fixed
// violation(s)" and exiting 0. An errored gate reports `violations: []` without having evaluated
// anything, so every previously-accepted entry looked orphaned.
//
// This scenario declares the CORRECT (fixed) behavior once: `align baseline prune` on an errored
// run REFUSES (exit 1) and leaves the baseline byte-identical. `{ install: 'target' }` means
// "whatever version this invocation is testing" — run this exact file against `0.1.4` and the
// `run` step's `expect: { exit: 1 }` fails (0.1.4 actually exits 0), which is the harness going
// RED on a real published bug. Run it against `local` and it passes — GREEN.
//
// The errored run is triggered by 'shadow-component' (lib/mutations.mjs): a component matching
// every file, declared before the real ones, so first-match-wins classification leaves every
// real component with zero files — `validateClassifiedComponents` throws, `verdict: 'error'`.
// This is the actual code path the bug lived in, not a synthetic error injection.
export default {
  id: 'prune-errored-run-destroys-baseline',
  project: 'nest',
  description:
    "align baseline prune must refuse (not silently destroy accepted debt) when the scan that computed \"what's " +
    'orphaned\" never actually evaluated any rule (bug hunt 2026-08-08 BUG #18, ADR 023 tier 1).',
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    // A real, deterministic violation (packages/core -> packages/common at the pinned commit) so
    // the baseline entry `prune` is destroying is tied to a real file, not a synthetic one.
    { mutate: 'introduce-arch-violation' },
    { run: 'baseline accept', expect: { exit: 0 } },
    { snapshot: 'after-accept' },
    { mutate: 'shadow-component' },
    {
      run: 'baseline prune',
      expect: { exit: 1, stderrContains: 'refusing to prune' },
    },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
  ],
};
