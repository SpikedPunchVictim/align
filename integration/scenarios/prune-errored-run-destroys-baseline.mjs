// ADR 025 §5, "the harness must be able to fail" — the highest-priority scenario in increment 1.
//
// Real bug, fixed on this branch (commit a0d2baa, and 0db10d7 before it): `align baseline prune`
// on an ERRORED run destroyed every accepted baseline entry while printing "Pruned N fixed
// violation(s)" and exiting 0. An errored gate reports `violations: []` without having evaluated
// anything, so every previously-accepted entry looked orphaned.
//
// This scenario declares the CORRECT (fixed) behavior once: `align baseline prune` on an errored
// run REFUSES (exit 1) and leaves the baseline unchanged. `{ install: 'target' }` means "whatever
// version this invocation is testing" — run this exact file against `0.1.4` and the `run` step's
// `expect: { exit: 1 }` fails (0.1.4 actually exits 0), which is the harness going RED on a real
// published bug. Run it against `local` and it passes — GREEN.
//
// F9 note: the `fileUnchanged` assert below compares NORMALIZED text (acceptedAt and the other
// volatile JSON keys blanked, see lib/normalize.mjs's VOLATILE_JSON_KEYS), not raw bytes — an
// earlier version of this comment said "byte-identical", which overclaimed what the assertion
// mechanism itself verifies. In THIS specific scenario the refusal path also happens not to write
// the file at all, so the actual bytes are unchanged too — but that's a property of align's
// refusal behavior, not something the harness's comparison guarantees in general.
//
// F6 note: `after-accept`'s baseline entry count is pinned below (`jsonArrayLength`) so a nest-pin
// bump or rule change that made 'introduce-arch-violation' yield zero violations fails LOUDLY here
// instead of silently degrading the destruction assertion to comparing `[]` with `[]`.
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
  // F3: this is the flagship "the harness must be able to fail" proof (ADR 025 §5) — the whole
  // point is that it goes RED on 0.1.4. `expectFailOn` makes that a machine-checked requirement,
  // not just a comment: if 0.1.4 is included in `--targets` and this scenario PASSES against it,
  // `run.mjs` treats that as a red/green calibration break and exits non-zero, regardless of
  // `--gate-target`. Without this, a normalization change or an F1-style typo that silently made
  // 0.1.4 go green would leave the run reporting overall success.
  expectFailOn: ['0.1.4'],
  // ADR 026: `baseline prune` is the command BUG #18 lived in — the exact class this scenario
  // exists to catch. The refusal path (`exit 1`) writes nothing, so the write-set is only the
  // COMMON `init`/`install` set (see init-fresh-project.mjs's write-set comment) plus `baseline
  // accept`, which also only touches paths already in that set.
  tags: ['destructive'],
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json'],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    // A real, deterministic violation (packages/core -> packages/common at the pinned commit) so
    // the baseline entry `prune` is destroying is tied to a real file, not a synthetic one.
    { mutate: 'introduce-arch-violation' },
    { run: 'baseline accept', expect: { exit: 0 } },
    { snapshot: 'after-accept' },
    // F6: pins the seed. Verified empirically against the pinned nest commit (2026-08-09): 389
    // baseline entries (one per violating import edge — packages/core -> packages/common,
    // `evaluateLayers` fingerprints per edge, not per file or per rule). If a nest pin bump or a
    // rule-evaluation change ever made 'introduce-arch-violation' yield zero violations, THIS
    // assertion fails loudly here — before the destruction assertion below would otherwise
    // silently degrade to comparing `[]` with `[]` and passing vacuously.
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', equals: 389 } },
    { mutate: 'shadow-component' },
    {
      run: 'baseline prune',
      expect: { exit: 1, stderrContains: 'refusing to prune' },
    },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
  ],
};
