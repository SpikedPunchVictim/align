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
  // ADR 026 write-set. `init`'s COMMON set (see init-fresh-project.mjs's write-set comment) plus
  // `install`'s package-lock.json is the whole list — `corrupt-config` (a `mutate` step, not an align
  // command) overwrites align.config.ts wholesale, same declared path, no new one.
  //
  // **This comment used to say "`align doctor`/`align check` never write", and half of it has been
  // false since ADR 029** (found by review 2026-08-19): `align doctor` still writes nothing, but every
  // `align check` records `.align/last-scan.json`. The write-set below is nonetheless correct, for a
  // reason that was accidental until it was written down: this scenario's ONLY `check` runs after
  // `corrupt-config`, so it dies inside `loadConfig` before the scan — and therefore before the
  // record write. That dependency is now ASSERTED at the last step rather than relied upon, because a
  // scenario whose write-set is right by luck fails confusingly the day someone reorders it.
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json'],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0 } },
    { run: 'doctor', expect: { exit: 0 } },
    { run: 'doctor --json', expect: { exit: 0 } },
    { mutate: 'corrupt-config' },
    { run: 'doctor', expect: { exit: 0 } },
    { run: 'doctor --json', expect: { exit: 0 } },
    { run: 'check', expect: { exit: 1 } },
    // The assertion that makes the write-set above honest rather than lucky. `check` writes the scan
    // record on every run that gets as far as scanning (ADR 029); this one does not, because the
    // config fails to parse first. If that ever changes — a `check` that scans before loading the
    // config, or a record written on the error path — this fails HERE, naming the property, instead
    // of surfacing as an undeclared-path write-set violation three steps away from its cause.
    { assert: { kind: 'exists', file: '.align/last-scan.json', equals: false } },
  ],
};
