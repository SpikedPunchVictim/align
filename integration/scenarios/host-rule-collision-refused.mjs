// LEDGER D063 — two `custom.host` findings that share one message were folded into one baseline
// signature, and accepting it accepted findings nobody had reviewed.
//
// align identifies a `custom.host` finding by `['custom', ruleId, file, message]` and deliberately
// NOT by line number (a line number would orphan the baseline entry the moment anything above the
// finding moved). So two findings from one predicate, in one file, carrying one message are one
// signature. Before the fix `evaluateCustomHost` let them collapse: accepting the single entry
// accepted both, and — the part that makes this severity zero — accepted every LATER finding that
// hashed the same way. A third finding could appear in that file and `align check` stayed green,
// exit 0, baselined debt unchanged. Nothing in the output distinguished "reviewed and accepted"
// from "never seen".
//
// The rule the collapse violated was written down, in the `HostViolation` doc comment, as advice to
// predicate authors: put the distinguishing detail in `message`. It was advice, unchecked — which
// is this repository's standing lesson that a doc comment asserting a safety property is a claim to
// verify, not evidence.
//
// **What this scenario proves that the unit tests cannot.** `host-violation-collision.test.ts`
// drives `evaluateCustomHost` directly. This drives a real `align.config.ts` with a real
// `hostRules` export through the real binary against a real repository — the path where the
// predicate is host-side code loaded from a config file, which is the only way a user ever meets
// this. It also proves the refusal LIFTS: a scenario that only showed align refusing would be
// satisfied by an align that refused every host rule.
//
// **No `expectFailOn`, and the reason was verified two independent ways rather than recalled.**
// Reading the published 0.1.4 tarball: its fingerprint is
// `computeFingerprint(['custom', rule.id, hv.file, String(range.startLine), hv.message])` — it
// separates by LINE. And running THIS scenario against a real 0.1.4 through the harness
// (2026-08-21): `architecture RED 2 violation(s)`, both findings listed separately. 0.1.4 does not
// collapse them, so it does not have this defect, and a pin against it would be a false claim.
// The source read alone would have been an inference; the run is the measurement. The regression is 0.2.0's: dropping `startLine` from the identity (the right call for
// baseline stability) removed the only thing keeping these two findings apart, and nothing replaced
// it [S-14]. Reproduce against the version that has it with `--targets 0.2.0,local`. This scenario
// still goes red against 0.1.4 — 0.1.4 reports two violations where a fixed align refuses — and
// that red is informational, exactly like the three other scenarios undeclared for version reasons.
export default {
  id: 'host-rule-collision-refused',
  project: 'nest',
  description:
    'A custom.host predicate returning two findings for one file under one message makes align REFUSE the run rather ' +
    'than collapse them into one baseline signature; giving the findings distinct messages lifts the refusal and both ' +
    'are reported and accepted separately (LEDGER D063).',
  // ADR 026: `baseline accept` writes, so this earns the tag. COMMON set (see init-fresh-project.mjs
  // for the derivation) and nothing more — the two mutations edit `align.config.ts`, already in the
  // set, and the refusing `check` writes no baseline at all.
  tags: ['destructive'],
  writeSet: [
    // ADR 029: every `align check` records what it observed in `.align/last-scan.json`.
    '.align/last-scan.json',
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
  ],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    // Green and quiet before the host rule exists, so every assertion below is a change this
    // scenario caused rather than pre-existing state.
    { run: 'check', expect: { exit: 0, stdoutNotContains: 'custom.host' } },
    { snapshot: 'before-host-rule' },

    // ---- The collision. ----
    { mutate: 'add-colliding-host-rule' },
    {
      run: 'check',
      // ERROR, not RED: align cannot tell which finding a human would be accepting, so it declines
      // to produce a verdict at all rather than producing one it cannot stand behind. The message
      // has to name the file and say why, or a user cannot act on it.
      // `[\s\S]` rather than `.` between the two tokens: align wraps its messages, the rule id and
      // the file land on different lines, and a JS `.` does not match a newline — a `.{0,400}?` here
      // failed against output that plainly contained both (measured 2026-08-21). A pattern that
      // cannot match the real output is the same false-negative class this harness hunts, just
      // pointed at itself.
      expect: {
        exit: 1,
        stdoutContains: 'are one signature',
        stdoutMatches: 'custom\\.host:harness-two-findings[\\s\\S]{0,400}?packages/core/index\\.ts',
        stdoutNotContains: 'verdict: green',
      },
    },
    // The refusal wrote nothing. An errored run must not leave a partial baseline behind — the
    // damage this whole family of guards exists to prevent.
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'before-host-rule' } },
    // ADR 023's add-only exemption, pinned rather than assumed (CLAUDE.md requires the exemption be
    // pinned by a test). `baseline accept` is add-only and is therefore NOT gated by
    // `refuseIfRunErrored` — but an errored run evaluated nothing, so there is nothing to add, and
    // the baseline must come out identical. "Exempt from the guard" must not mean "free to write".
    { run: 'baseline accept', expect: { exit: 0 } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'before-host-rule' } },

    // ---- The documented fix, applied. ----
    // align's own refusal text tells the author to "give each finding a message that identifies it".
    // If following that advice did not clear the refusal, the advice would be wrong and the refusal
    // would be a dead end rather than a guard.
    { mutate: 'distinguish-host-rule-messages' },
    {
      run: 'check',
      // Now a genuine RED with BOTH findings visible and separately identified. `stdoutContains` on
      // each message is what proves they did not collapse — a count assertion would be satisfied by
      // one finding reported twice.
      expect: {
        exit: 1,
        stdoutContains: 'harness finding: first',
        stdoutNotContains: 'are one signature',
      },
    },
    { run: 'check', expect: { exit: 1, stdoutContains: 'harness finding: second' } },
    // Accepting now accepts two distinct entries, and the repository returns to green — the state
    // the collapsed identity reached WITHOUT anyone having reviewed the second finding.
    { run: 'baseline accept', expect: { exit: 0, stdoutContains: 'Accepted' } },
    { assert: { kind: 'fileChanged', file: '.align/baseline.json', since: 'before-host-rule' } },
    { run: 'check', expect: { exit: 0 } },
  ],
};
