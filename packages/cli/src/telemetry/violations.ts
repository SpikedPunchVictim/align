import { diffViolationState, telemetryStateEntryOf, type TelemetryEvent, type Violation } from '@spikedpunch/align-core';
import { readTelemetryState, writeTelemetryState } from '../align-dir.js';

/**
 * `violation-appeared`/`violation-resolved` (IMPLEMENTATION_PLAN.md's telemetry spec): diffs the
 * current check's non-baselined violation set against `.align/telemetry-state.json` (the previous
 * check's set), then persists the new set for the next invocation. Only called when telemetry is
 * enabled — a disabled run must never touch `telemetry-state.json` (OFF-by-default writes
 * nothing), so gating happens at the call site (`commands/check.ts`), not here.
 */
export function computeAndPersistViolationTransitions(rootDir: string, violations: readonly Violation[]): readonly TelemetryEvent[] {
  const previous = readTelemetryState(rootDir).violations;
  const current = violations.map((v) => telemetryStateEntryOf(v));
  const diff = diffViolationState(previous, current);
  writeTelemetryState(rootDir, { violations: current });

  const events: TelemetryEvent[] = [];
  for (const e of diff.appeared) {
    events.push({
      kind: 'violation-appeared',
      ruleId: e.ruleId,
      file: e.file,
      violationFingerprint: e.fingerprint,
      ...(e.component !== undefined ? { component: e.component } : {}),
    });
  }
  for (const e of diff.resolved) {
    events.push({
      kind: 'violation-resolved',
      ruleId: e.ruleId,
      file: e.file,
      violationFingerprint: e.fingerprint,
      ...(e.component !== undefined ? { component: e.component } : {}),
    });
  }
  return events;
}
