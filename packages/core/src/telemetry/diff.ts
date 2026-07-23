import type { Violation } from '../types/violation.js';
import type { TelemetryStateEntry } from './types.js';

/**
 * `violation-appeared` / `violation-resolved` (IMPLEMENTATION_PLAN.md telemetry spec) are computed
 * by diffing the current check's violation-fingerprint set against the previous check's set — this
 * is that diff, pure and framework-free (no file I/O; the CLI reads/writes
 * `.align/telemetry-state.json` and calls this with both sides already loaded).
 *
 * Only the fields needed to *name* a transition travel with each entry (ruleId/file/component) —
 * paths + rule ids only, never file contents (the same discipline every other violation-facing
 * payload in this codebase already follows, ADR 007).
 */
export function componentOfViolation(v: Violation): string | undefined {
  switch (v.kind) {
    case 'no-dependency':
    case 'no-dependency-external':
      return v.fromComponent;
    case 'layers':
    case 'layers-external':
      return v.fromLayer;
    case 'metric':
      return v.component;
    case 'no-cycles':
    case 'custom':
    case 'manifest-source-hygiene':
    case 'manifest-new-dependency':
      return undefined;
    default: {
      const exhaustive: never = v;
      throw new Error(`unhandled violation kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function telemetryStateEntryOf(v: Violation): TelemetryStateEntry {
  const component = componentOfViolation(v);
  return {
    fingerprint: v.id,
    ruleId: v.ruleId,
    file: v.file,
    ...(component !== undefined ? { component } : {}),
  };
}

export interface ViolationStateDiff {
  readonly appeared: readonly TelemetryStateEntry[];
  readonly resolved: readonly TelemetryStateEntry[];
}

/**
 * `previous`/`current` are both `TelemetryStateEntry[]` (not raw `Violation[]`) so this stays a
 * pure comparison over the persisted, minimal shape — `telemetryStateEntryOf` above is the one
 * place a `Violation` gets narrowed down to it. Diffed by `fingerprint` only (ADR 006: stable
 * under unrelated edits — a violation with the same fingerprint is the same violation even if its
 * line number shifted).
 */
export function diffViolationState(previous: readonly TelemetryStateEntry[], current: readonly TelemetryStateEntry[]): ViolationStateDiff {
  const previousIds = new Set(previous.map((e) => e.fingerprint));
  const currentIds = new Set(current.map((e) => e.fingerprint));
  return {
    appeared: current.filter((e) => !previousIds.has(e.fingerprint)),
    resolved: previous.filter((e) => !currentIds.has(e.fingerprint)),
  };
}
