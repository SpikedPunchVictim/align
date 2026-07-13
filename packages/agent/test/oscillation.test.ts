import { describe, expect, it } from 'vitest';
import { toRuleId, toViolationId } from '@spikedpunch/align-core';
import { detectOscillation, type AttemptFingerprint } from '../src/oscillation.js';

function fp(violationIds: string[], ruleIds: string[]): AttemptFingerprint {
  return { violationIds: new Set(violationIds.map(toViolationId)), ruleIds: new Set(ruleIds.map(toRuleId)) };
}

describe('detectOscillation', () => {
  it('is not oscillating with fewer than two attempts', () => {
    expect(detectOscillation([fp(['v1'], ['r1'])]).oscillating).toBe(false);
  });

  it('is not oscillating when attempts make monotonic progress', () => {
    const history = [fp(['v1', 'v2'], ['r1', 'r2']), fp(['v2'], ['r2']), fp([], [])];
    expect(detectOscillation(history).oscillating).toBe(false);
  });

  it('detects a fix-A-introduces-B-then-B-reintroduces-A cycle and names both rule ids', () => {
    // attempt 0: violation A present. attempt 1 (fixed A, introduced B). attempt 2 (fixed B, reintroduced A) — same set as 0.
    const history = [fp(['vA'], ['rule-a']), fp(['vB'], ['rule-b']), fp(['vA'], ['rule-a'])];
    const result = detectOscillation(history);
    expect(result.oscillating).toBe(true);
    expect(result.repeatedAtIndex).toBe(0);
    expect(result.conflictingRuleIds).toEqual([toRuleId('rule-a'), toRuleId('rule-b')]);
  });

  it('does not treat two empty sets as an oscillation (no violations is not a cycle)', () => {
    const history = [fp([], []), fp(['v1'], ['r1']), fp([], [])];
    expect(detectOscillation(history).oscillating).toBe(false);
  });
});
