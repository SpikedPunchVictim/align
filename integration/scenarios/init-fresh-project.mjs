// ADR 025 §7 coverage table, `init` row: "fresh project ... non-interactive requires
// --accept-existing (ADR 006)". Asserts the observable contract of a first-ever `align init` on a
// real, previously-un-aligned repo: components detected (nest's real count, verified 2026-08-08:
// 9 — one per npm-workspace package under packages/*), align.config.ts written, baseline seeded,
// CLAUDE.md align block written.
export default {
  id: 'init-fresh-project',
  project: 'nest',
  description: 'align init --accept-existing on a fresh nest checkout detects components, writes align.config.ts, seeds the baseline, writes the CLAUDE.md block.',
  // ADR 026 write-set. `init` is BUG #10's own command (docs/adr/026-2026-08-11-declared-write-sets.md:13-28),
  // so it earns the `destructive` tag even though this scenario runs it exactly once on a fresh
  // checkout (nothing pre-existing to destroy here — the risk is in a RE-run, which this scenario
  // doesn't exercise). Traced against packages/cli/src/commands/init.ts + align-dir.ts:
  //   - align.config.ts        — renderConfig (fresh) + writeGeneratedRulesNote's marker splice.
  //   - CLAUDE.md               — writeAgentInstructions (init/claude-md.ts).
  //   - .gitignore              — ensureTelemetryGitignored appends the two telemetry entries; nest's
  //                               own .gitignore doesn't have them yet, so this fires on every run.
  //   - package.json            — offerAlignScript adds `"align": "align check"` (init.ts's finish()
  //                               path runs unconditionally, and the harness's non-interactive/no-TTY
  //                               invocation defaults the prompt to yes per npm-script.ts's own doc
  //                               comment: "silence defaults to ADDING this one, low-risk... script").
  //   - .align/baseline.json    — writeBaseline (the accept-existing seed path).
  //   - .align/version.json     — stampAlignVersion (inside writeBaseline) + recordBaselineReconciled.
  //   - package-lock.json       — not `init`'s doing; the PRECEDING `install` step's real `npm
  //                               install` (lib/version-install.mjs) rewrites it every scenario.
  tags: ['destructive'],
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json'],
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
