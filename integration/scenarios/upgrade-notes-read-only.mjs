// ADR 025 Tier-1 #2: `align upgrade --notes` is read-only — mutates nothing under `.align/`.
// Runs against `target` (the build under test, which — unlike a real pre-0.2.0 published version —
// already stamps `.align/version.json` on `init`/`baseline accept`, per ADR 022's write discipline)
// so `.align/version.json` genuinely EXISTS before `--notes` ever runs; the assertion that matters
// is that it is byte-for-byte (normalized) UNCHANGED afterward, not merely that it's still absent.
export default {
  id: 'upgrade-notes-read-only',
  project: 'nest',
  description: 'align upgrade --notes mutates nothing under .align/, including a version.json that already exists.',
  // ADR 026: `upgrade --notes` is explicitly read-only (this scenario's whole point), so its
  // write-set is exactly the COMMON `init`/`install`/`baseline accept` set — see
  // init-fresh-project.mjs's write-set comment — with nothing added for `--notes` itself. Compare
  // with upgrade-with-existing-baseline.mjs, which DOES exercise the mutating `upgrade --yes` path.
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json'],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { mutate: 'introduce-arch-violation' },
    { run: 'baseline accept', expect: { exit: 0 } },
    { assert: { kind: 'exists', file: '.align/version.json', equals: true } },
    { snapshot: 'after-accept' },
    { run: 'upgrade --notes', expect: { exit: 0 } },
    { run: 'upgrade --notes --from 0.1.0', keepVersion: true, expect: { exit: 0, stdoutContains: '0.1.0 → ' } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-accept' } },
    { assert: { kind: 'fileUnchanged', file: '.align/version.json', since: 'after-accept' } },
    { assert: { kind: 'fileUnchanged', file: 'align.config.ts', since: 'after-accept' } },
  ],
};
