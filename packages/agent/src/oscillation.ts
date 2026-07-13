/**
 * Oscillation detection (REPAIR loop guard, ADR 012 shape-2 conflicts): per-file fingerprint-set
 * history across REPAIR attempts. Fix A introduces violation B; fix B reintroduces violation A —
 * the violation-id set returns to one already seen earlier in this group's history. That's a
 * cycle in the state space, not progress — stop immediately and escalate naming both rule ids,
 * rather than burning the remaining REPAIR budget ping-ponging.
 */
import type { RuleId, ViolationId } from '@spikedpunch/align-core';

export interface AttemptFingerprint {
  readonly violationIds: ReadonlySet<ViolationId>;
  readonly ruleIds: ReadonlySet<RuleId>;
}

export interface OscillationResult {
  readonly oscillating: boolean;
  /** Index into the history array of the earlier attempt whose fingerprint the latest attempt
   * repeats — present only when `oscillating` is true. */
  readonly repeatedAtIndex?: number;
  /** Rule ids present in both the repeated attempt and the current one — named in the escalation
   * report per the plan's "conflicting rules" requirement. */
  readonly conflictingRuleIds?: readonly RuleId[];
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/**
 * `history` is ordered oldest-to-newest, one entry per REPAIR attempt (including the initial
 * DISCOVER state as index 0). Detects whether the LATEST entry's violation-id set exactly matches
 * any earlier entry's set.
 */
export function detectOscillation(history: readonly AttemptFingerprint[]): OscillationResult {
  if (history.length < 2) return { oscillating: false };
  const latest = history[history.length - 1] as AttemptFingerprint;

  for (let i = 0; i < history.length - 1; i++) {
    const earlier = history[i] as AttemptFingerprint;
    if (setsEqual(earlier.violationIds, latest.violationIds) && earlier.violationIds.size > 0) {
      // Name every rule id seen across the whole repeated span (index i..latest), not just the
      // two matching endpoints — "fix A introduces B, fix B reintroduces A" means the rule ids
      // that changed hands mid-cycle (B) are exactly what the escalation report must name
      // alongside the rule that oscillated back (A).
      const conflictingRuleIds = [...new Set(history.slice(i).flatMap((h) => [...h.ruleIds]))];
      return { oscillating: true, repeatedAtIndex: i, conflictingRuleIds };
    }
  }
  return { oscillating: false };
}
