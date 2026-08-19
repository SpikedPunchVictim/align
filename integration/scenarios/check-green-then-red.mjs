// ADR 025 §7 coverage table, `check` row: "exit 0 iff green". Green immediately after `init`
// (the baseline absorbed every pre-existing violation); red once a real, un-baselined violation
// is introduced. Reuses the same 'introduce-arch-violation' mutation the prune scenario uses to
// seed real debt — here left un-baselined on purpose, so it shows up as new red.
export default {
  id: 'check-green-then-red',
  project: 'nest',
  description: 'align check exits 0 on a freshly-initialized repo and exits 1 (verdict: red) once a real, un-baselined violation exists.',
  // ADR 026 write-set. `align check` writes `.align/baseline.json` only via `persistMovedBaseline`
  // when a file MOVE is detected (commands/check.ts), and nothing here renames a file — but since
  // ADR 029 it ALSO records `.align/last-scan.json` on every run, so "check never writes" is no
  // longer true and the note below is the accurate version. Every other path comes from the one
  // `init --accept-existing` step;
  // see init-fresh-project.mjs's write-set comment for the full per-path trace (align.config.ts,
  // CLAUDE.md, .gitignore, package.json, .align/baseline.json, .align/version.json) plus the
  // preceding `install` step's package-lock.json. `introduce-arch-violation` (a `mutate` step, not
  // an align command) edits align.config.ts again — same declared path, no new one.
  // `.align/last-scan.json`: every `align check` records what it observed (ADR 029). Declared
  // rather than exempted — a machine-local cache is still a path align writes into someone
  // else's repository, and ADR 026's set is what a reader consults to know that.
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json', '.align/last-scan.json'],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    { run: 'check', expect: { exit: 0 } },
    { run: 'check --json', expect: { exit: 0, stdoutContains: '"verdict": "green"' } },
    { mutate: 'introduce-arch-violation' },
    { run: 'check', expect: { exit: 1 } },
    { run: 'check --json', expect: { exit: 1, stdoutContains: '"verdict": "red"' } },
  ],
};
