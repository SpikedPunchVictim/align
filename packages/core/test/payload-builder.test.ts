import { describe, expect, it } from 'vitest';
import { buildMcpCheckPayload } from '../src/payload/builder.js';
import { computeFingerprint } from '../src/baseline/fingerprint.js';
import { toComponentName, toRepoRelativePath, toRuleId } from '../src/types/branded.js';
import type { CheckRun } from '../src/gates/types.js';
import type { Violation } from '../src/types/violation.js';

function violation(ruleId: string, n: number): Violation {
  return {
    id: computeFingerprint([ruleId, String(n)]),
    ruleId: toRuleId(ruleId),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath(`a${n}.ts`),
    range: { startLine: n, endLine: n },
    snippet: `import x from './b${n}'`,
    fixHint: { code: 'manual-review' },
    kind: 'no-dependency',
    fromFile: toRepoRelativePath(`a${n}.ts`),
    toFile: toRepoRelativePath(`b${n}.ts`),
    fromComponent: toComponentName('x'),
    toComponent: toComponentName('y'),
    specifier: `./b${n}`,
    line: n,
  };
}

function runWith(violations: Violation[]): CheckRun {
  return {
    verdict: violations.length > 0 ? 'red' : 'green',
    gates: [
      { gate: 'parse', status: 'green', violations: [], baselinedCount: 0, durationMs: 1, cacheHits: 0, dependsOn: [] },
      {
        gate: 'architecture',
        status: violations.length > 0 ? 'red' : 'green',
        violations,
        baselinedCount: 0,
        durationMs: 1,
        cacheHits: 0,
        dependsOn: ['parse'],
      },
    ],
    advisories: [],
    scannedAt: Date.now(),
  };
}

describe('buildMcpCheckPayload', () => {
  it('caps violations at maxPerRule per rule', () => {
    const violations = Array.from({ length: 15 }, (_, i) => violation('r1', i));
    const payload = buildMcpCheckPayload(runWith(violations), { maxPerRule: 10 });
    expect(payload.violations).toHaveLength(10);
  });

  it('never emits per-item text for passing gates — only counts', () => {
    const payload = buildMcpCheckPayload(runWith([]));
    expect(payload.violations).toHaveLength(0);
    expect(payload.gates.every((g) => 'violationCount' in g)).toBe(true);
  });

  it('sorts by rule id deterministically within a category', () => {
    const violations = [violation('r2', 1), violation('r1', 1)];
    const payload = buildMcpCheckPayload(runWith(violations));
    expect(payload.violations[0]?.ruleId).toBe('r1');
    expect(payload.violations[1]?.ruleId).toBe('r2');
  });

  it('paginates beyond pageSize with a cursor', () => {
    const violations = Array.from({ length: 5 }, (_, i) => violation(`r${i}`, i));
    const payload = buildMcpCheckPayload(runWith(violations), { pageSize: 2, maxPerRule: 10 });
    expect(payload.violations).toHaveLength(2);
    expect(payload.pagination?.hasMore).toBe(true);
    expect(payload.pagination?.cursor).toBeDefined();
  });
});
