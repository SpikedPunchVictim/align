import { describe, expect, it } from 'vitest';
import { computeImpactDelta } from '../../src/build/impact.js';
import type { Violation } from '../../src/types/violation.js';
import type { BaselineEntry } from '../../src/baseline/store.js';
import { toComponentName, toRuleId, toRepoRelativePath, toViolationId } from '../../src/types/branded.js';

function violation(id: string): Violation {
  return {
    id: toViolationId(id),
    ruleId: toRuleId('r'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath('a.ts'),
    range: { startLine: 1, endLine: 1 },
    snippet: 'x',
    fixHint: { code: 'manual-review' },
    kind: 'no-dependency',
    fromFile: toRepoRelativePath('a.ts'),
    toFile: toRepoRelativePath('b.ts'),
    fromComponent: toComponentName('a'),
    toComponent: toComponentName('b'),
    specifier: './b',
    line: 1,
  } as Violation;
}

function baselineEntry(fingerprint: string): BaselineEntry {
  return {
    fingerprint: toViolationId(fingerprint),
    ruleId: toRuleId('r'),
    file: toRepoRelativePath('a.ts'),
    acceptedAt: 0,
    acceptedBy: 'manual',
  };
}

describe('computeImpactDelta', () => {
  it('reports a new violation not present before and not baselined', () => {
    const current = [violation('a')];
    const proposed = [violation('a'), violation('b')];
    const delta = computeImpactDelta(current, proposed, []);
    expect(delta.addedNew.map((v) => v.id)).toEqual(['b']);
    expect(delta.maskedBaselined).toHaveLength(0);
  });

  it('does not count an already-baselined violation as new', () => {
    const current = [violation('a')];
    const proposed = [violation('a'), violation('b')];
    const delta = computeImpactDelta(current, proposed, [baselineEntry('b')]);
    expect(delta.addedNew).toHaveLength(0);
  });

  it('reports a baselined violation that the proposed ruleset no longer evaluates as masked', () => {
    const current = [violation('a')];
    const proposed: Violation[] = [];
    const delta = computeImpactDelta(current, proposed, [baselineEntry('a')]);
    expect(delta.maskedBaselined.map((e) => e.fingerprint)).toEqual(['a']);
  });

  it('a baseline entry for a violation that never appeared in current is not masked (nothing to mask)', () => {
    const delta = computeImpactDelta([], [], [baselineEntry('stale')]);
    expect(delta.maskedBaselined).toHaveLength(0);
  });
});
