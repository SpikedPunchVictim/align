// ADR 025 §7 `telemetry` row: "with a populated .align/telemetry.jsonl; with none" — "absent file
// is not an error". `.align/telemetry.jsonl` is outside `lib/capture.mjs`'s fixed capture catalog
// (opt-in, and not one of the four/five artifacts that catalog names — see
// `export-ir-then-check-untrusted.mjs`'s comment for the same limitation with a different file), so
// this scenario verifies through the `telemetry` command's own report rather than a captured-file
// assertion. Deliberately uses the human-readable report, not `--json`, for the populated case:
// `align check --telemetry`'s recorded latency is genuine wall-clock time and differs between runs
// by construction — the human report's "p50=1.1s"-shaped tokens go through
// `lib/normalize.mjs`'s `wall-clock-durations` rule and normalize away, but a bare JSON number
// (`"p50": 1074.54`) is not text with a unit suffix and would NOT be caught by that rule, which
// would break the harness's own determinism property (two runs must produce byte-identical
// normalized artifacts) for no reason connected to what this scenario is actually testing.
export default {
  id: 'telemetry-with-and-without-file',
  project: 'nest',
  description: 'align telemetry reports "0 event(s)" with no telemetry.jsonl (not an error), and a real summary once one exists.',
  // ADR 026: COMMON set (see init-fresh-project.mjs's write-set comment) plus the two files
  // `check --telemetry` writes when force-enabled for that one run — `appendTelemetryLine` (the
  // event log) and `computeAndPersistViolationTransitions` -> `writeTelemetryState` (the
  // appear/resolve diff state, telemetry/violations.ts), both gated on `recorder.enabled` and both
  // fire together, never independently (telemetry.ts's own `align telemetry` REPORT command is
  // read-only and writes neither).
  writeSet: [
    // ADR 029: every `align check` records what it observed in `.align/last-scan.json`. Declared
    // rather than exempted — a machine-local cache is still a path align writes into someone
    // else's repository, and ADR 026's set is what a reader consults to know that.
    '.align/last-scan.json',
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    '.align/telemetry.jsonl',
    '.align/telemetry-state.json',
  ],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { run: 'telemetry', expect: { exit: 0, stdoutContains: 'align telemetry — 0 event(s) read' } },
    { run: 'telemetry --json', expect: { exit: 0, stdoutContains: '"totalEvents": 0' } },
    // Force-enables telemetry for this one run (ADR: --telemetry/--no-telemetry override
    // ALIGN_TELEMETRY/align.config.ts) — writes .align/telemetry.jsonl for the first time.
    { run: 'check --telemetry --json', expect: { exit: 0 } },
    { run: 'telemetry', expect: { exit: 0, stdoutContains: 'align telemetry — 1 event(s) read' } },
  ],
};
