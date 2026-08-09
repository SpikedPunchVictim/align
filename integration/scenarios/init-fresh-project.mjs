// ADR 025 §7 coverage table, `init` row: "fresh project ... non-interactive requires
// --accept-existing (ADR 006)". Asserts the observable contract of a first-ever `align init` on a
// real, previously-un-aligned repo: components detected (nest's real count, verified 2026-08-08:
// 9 — one per npm-workspace package under packages/*), align.config.ts written, baseline seeded,
// CLAUDE.md align block written.
export default {
  id: 'init-fresh-project',
  project: 'nest',
  description: 'align init --accept-existing on a fresh nest checkout detects components, writes align.config.ts, seeds the baseline, writes the CLAUDE.md block.',
  steps: [
    { install: 'target' },
    {
      run: 'init --accept-existing',
      expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' },
    },
    { assert: { kind: 'exists', file: 'align.config.ts', equals: true } },
    { assert: { kind: 'exists', file: '.align/baseline.json', equals: true } },
    { assert: { kind: 'exists', file: 'CLAUDE.md', equals: true } },
  ],
};
