// ADR 025 §7 `explain` row: known rule id; unknown rule id — "unknown id fails cleanly, no stack
// trace".
export default {
  id: 'explain-known-and-unknown-rule',
  project: 'nest',
  description: 'align explain prints structured JSON for a known rule id and fails cleanly (no stack trace) for an unknown one.',
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { mutate: 'introduce-arch-violation' },
    {
      run: "explain arch.no-dependency:core->common",
      expect: { exit: 0, stdoutContains: '"ruleId": "arch.no-dependency:core->common"', stdoutMatches: '"kind": "arch\\.no-dependency"' },
    },
    { run: 'explain arch.no-cycles:repo', expect: { exit: 0, stdoutContains: '"kind": "arch.no-cycles"' } },
    {
      run: "explain nope.totally-unknown-rule-id",
      expect: { exit: 1, stderrContains: "Unknown rule id 'nope.totally-unknown-rule-id'", stderrNotContains: 'at Object' },
    },
  ],
};
