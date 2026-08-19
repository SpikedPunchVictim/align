// LEDGER D038 (bug hunt B9) — `align baseline accept` must not rewrite the provenance of entries it
// did not newly accept.
//
// `store.accept` set every violation it was handed unconditionally, and the CLI hands it the FULL
// current violation set rather than only the unbaselined ones. So the second `accept` in a normal
// working sequence rewrote `acceptedBy` to 'manual' and `acceptedAt` to now on entries a person had
// accepted earlier, by a different route, at exit 0 — the exact defect `align init` had, fixed and
// pinned there (`cli/test/init-seed-provenance.test.ts`) and left standing on `accept`.
//
// **This is a multi-command scenario on purpose.** The unit test proves the store preserves the
// fields; what only a scenario can show is that the defect is reached by an ordinary sequence — seed
// with `init --accept-existing`, then accept something new — with no contrivance in between.
//
// `acceptedBy` and NOT `acceptedAt`: the harness blanks `acceptedAt` as a volatile key
// (`lib/normalize.mjs`'s VOLATILE_JSON_KEYS), so a timestamp assertion here would compare two
// placeholders and pass however the code behaved. The mode is the half that survives normalization,
// and it is the half `align baseline show` prints.
//
// Same seeding as `baseline-accept-rule-and-show.mjs`: `init --accept-existing` baselines nest's 18
// real `arch.no-cycles:repo` violations as 'accept-existing'; `introduce-arch-violation` then adds
// 371 genuinely new `arch.no-dependency:core->common` violations for the bare `accept` to stamp.
export default {
  id: 'accept-does-not-restamp-provenance',
  project: 'nest',
  description: "align baseline accept leaves an earlier entry's acceptedBy alone while stamping genuinely new ones.",
  // Pinned against the published version that has the defect. 0.1.4 rewrites all 18 to 'manual',
  // so the assertion below fails there — which is what makes this scenario calibration rather than
  // decoration. See CLAUDE.md: if these ever pass against 0.1.4 the harness has stopped working.
  expectFailOn: ['0.1.4'],
  // ADR 026: `baseline accept` is the subject; the write-set is the COMMON set, identical to
  // `baseline-accept-rule-and-show.mjs`, whose step sequence this one mirrors.
  tags: ['destructive'],
  writeSet: ['package.json', 'package-lock.json', 'align.config.ts', 'CLAUDE.md', '.gitignore', '.align/baseline.json', '.align/version.json', '.align/last-scan.json'],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    // PREMISE: the seed really did stamp 'accept-existing'. Without this the assertion after the
    // accept could pass because the entries were never 'accept-existing' to begin with.
    { assert: { kind: 'jsonArrayFieldValueCount', file: '.align/baseline.json', path: 'entries', field: 'acceptedBy', value: 'accept-existing', equals: 18 } },
    { mutate: 'introduce-arch-violation' },
    { run: 'check', expect: { exit: 1 } },
    { run: 'baseline accept', expect: { exit: 0, stdoutContains: 'Accepted 389 violation(s) into the baseline' } },
    { assert: { kind: 'jsonArrayLength', file: '.align/baseline.json', path: 'entries', equals: 389 } },
    // THE ASSERTION. Before the fix: 0 — every one of the 18 was rewritten to 'manual'.
    { assert: { kind: 'jsonArrayFieldValueCount', file: '.align/baseline.json', path: 'entries', field: 'acceptedBy', value: 'accept-existing', equals: 18 } },
    // ...and the command still did its job on the 371 it genuinely accepted. A fix that froze the
    // whole baseline would satisfy the line above while accepting nothing.
    { assert: { kind: 'jsonArrayFieldValueCount', file: '.align/baseline.json', path: 'entries', field: 'acceptedBy', value: 'manual', equals: 371 } },
    { run: 'check', expect: { exit: 0 } },
  ],
};
