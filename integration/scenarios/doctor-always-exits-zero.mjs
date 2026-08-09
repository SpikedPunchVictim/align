// ADR 025 §7 coverage table, `doctor` row: "exit code is ALWAYS 0 — including on a config error".
// A documented contract the project has broken once already (2026-08-03 audit: a config-error fix
// applied uniformly across commands gave `doctor` a non-zero exit path, caught by review rather
// than by a test — exactly the regression class this harness exists to catch mechanically).
//
// Two repo states, both must exit 0: a healthy repo, and one with a deliberately corrupted
// align.config.ts (the 'corrupt-config' mutation — a file that fails to PARSE, not merely a
// well-formed config that errors at evaluation, see lib/mutations.mjs). The final `check` step is
// a sanity check that the corruption is real (check must go non-green/erroring) — proof that
// doctor's exit 0 on the corrupted repo is a deliberate contract, not an accident of the mutation
// being a no-op.
export default {
  id: 'doctor-always-exits-zero',
  project: 'nest',
  description: 'align doctor never fails — exit 0 on a healthy repo AND on a repo with a corrupted align.config.ts.',
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    { run: 'doctor', expect: { exit: 0 } },
    { run: 'doctor --json', expect: { exit: 0 } },
    { mutate: 'corrupt-config' },
    { run: 'doctor', expect: { exit: 0 } },
    { run: 'doctor --json', expect: { exit: 0 } },
    { run: 'check', expect: { exit: 1 } },
  ],
};
