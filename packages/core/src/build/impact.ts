import type { BaselineEntry } from '../baseline/store.js';
import type { Violation } from '../types/violation.js';

export interface ImpactDelta {
  /** Violations the proposed ruleset produces that the current effective ruleset does not, and
   * that aren't already tolerated by the baseline — "adds N new violations" (ADR 011). */
  readonly addedNew: readonly Violation[];
  /** Baseline entries whose violation the current effective ruleset produces but the proposed one
   * does not (the rule that used to catch it is gone or narrowed) — "masks M baselined" (ADR 011):
   * the debt doesn't get *fixed*, it stops being *evaluated*, which is worth flagging separately
   * from a genuine fix. */
  readonly maskedBaselined: readonly BaselineEntry[];
}

/**
 * Compiles the proposed ruleset's impact relative to the current one (ADR 011's build-gate
 * default: "adds N new violations / masks M baselined"). Pure — both violation sets are supplied
 * by the caller (one fresh scan, evaluated twice against two rule sets — see
 * `packages/cli/src/commands/build.ts`), so this function does no scanning itself.
 */
export function computeImpactDelta(
  currentViolations: readonly Violation[],
  proposedViolations: readonly Violation[],
  baselineEntries: readonly BaselineEntry[],
): ImpactDelta {
  const currentIds = new Set(currentViolations.map((v) => v.id));
  const proposedIds = new Set(proposedViolations.map((v) => v.id));
  const baselinedIds = new Set(baselineEntries.map((e) => e.fingerprint));

  const addedNew = proposedViolations.filter((v) => !currentIds.has(v.id) && !baselinedIds.has(v.id));
  const maskedBaselined = baselineEntries.filter((e) => currentIds.has(e.fingerprint) && !proposedIds.has(e.fingerprint));

  return { addedNew, maskedBaselined };
}
