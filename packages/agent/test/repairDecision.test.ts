import { describe, expect, it } from 'vitest';
import { toRuleId, toViolationId } from '@align/core';
import { decideNextRepairAction } from '../src/repairDecision.js';
import type { AttemptFingerprint } from '../src/oscillation.js';

function fp(violationIds: string[], ruleIds: string[]): AttemptFingerprint {
  return { violationIds: new Set(violationIds.map(toViolationId)), ruleIds: new Set(ruleIds.map(toRuleId)) };
}

describe('decideNextRepairAction', () => {
  it('retries when under the attempt cap and no oscillation', () => {
    const decision = decideNextRepairAction([fp(['v1'], ['r1']), fp(['v2'], ['r2'])], 1, 3);
    expect(decision).toEqual({ action: 'retry', attempt: 2 });
  });

  it('escalates on max-attempts once the cap is reached', () => {
    const decision = decideNextRepairAction([fp(['v1'], ['r1']), fp(['v2'], ['r2'])], 3, 3);
    expect(decision).toEqual({ action: 'escalate', reason: 'max-attempts' });
  });

  it('escalates on oscillation even under the attempt cap, naming both rule ids', () => {
    const history = [fp(['vA'], ['rule-a']), fp(['vB'], ['rule-b']), fp(['vA'], ['rule-a'])];
    const decision = decideNextRepairAction(history, 1, 3);
    expect(decision.action).toBe('escalate-oscillation');
    if (decision.action === 'escalate-oscillation') {
      expect(decision.conflictingRuleIds).toEqual([toRuleId('rule-a'), toRuleId('rule-b')]);
    }
  });
});
