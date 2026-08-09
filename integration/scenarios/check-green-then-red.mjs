// ADR 025 §7 coverage table, `check` row: "exit 0 iff green". Green immediately after `init`
// (the baseline absorbed every pre-existing violation); red once a real, un-baselined violation
// is introduced. Reuses the same 'introduce-arch-violation' mutation the prune scenario uses to
// seed real debt — here left un-baselined on purpose, so it shows up as new red.
export default {
  id: 'check-green-then-red',
  project: 'nest',
  description: 'align check exits 0 on a freshly-initialized repo and exits 1 (verdict: red) once a real, un-baselined violation exists.',
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
