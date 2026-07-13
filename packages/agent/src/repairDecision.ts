/**
 * Pure REPAIR decision core (CODING_BEST_PRACTICES.md §14: functional core, imperative shell).
 * Given a group's attempt history, decides the next action — never touches git, the network, or
 * the filesystem. Consumed by `run.ts`'s imperative shell.
 */
import type { RuleId } from '@spikedpunch/align-core';
import { detectOscillation, type AttemptFingerprint } from './oscillation.js';

export type RepairDecision =
  | { readonly action: 'retry'; readonly attempt: number }
  | { readonly action: 'escalate'; readonly reason: 'max-attempts' }
  | { readonly action: 'escalate-oscillation'; readonly reason: 'oscillation'; readonly conflictingRuleIds: readonly RuleId[] };

/** `history` includes the initial (pre-fix) fingerprint at index 0 and one entry per completed
 * attempt after that; `attemptsSoFar` is the count of REPAIR attempts already made (not counting
 * the original PLAN+FIX). Max 3 REPAIR attempts per group, per the plan. */
export function decideNextRepairAction(
  history: readonly AttemptFingerprint[],
  attemptsSoFar: number,
  maxAttempts = 3,
): RepairDecision {
  const oscillation = detectOscillation(history);
  if (oscillation.oscillating) {
    return { action: 'escalate-oscillation', reason: 'oscillation', conflictingRuleIds: oscillation.conflictingRuleIds ?? [] };
  }
  if (attemptsSoFar >= maxAttempts) return { action: 'escalate', reason: 'max-attempts' };
  return { action: 'retry', attempt: attemptsSoFar + 1 };
}
