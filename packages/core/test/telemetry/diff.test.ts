import { describe, expect, it } from 'vitest';
import { componentOfViolation, diffViolationState, telemetryStateEntryOf } from '../../src/telemetry/diff.js';
import { toComponentName, toRepoRelativePath, toRuleId, toViolationId } from '../../src/types/branded.js';
import type { Violation } from '../../src/types/violation.js';

function noDependencyViolation(id: string, file = 'a.ts'): Violation {
  return {
    id: toViolationId(id),
    ruleId: toRuleId('r1'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath(file),
    range: { startLine: 1, endLine: 1 },
    snippet: 'import x',
    fixHint: { code: 'manual-review' },
    kind: 'no-dependency',
    fromFile: toRepoRelativePath(file),
    toFile: toRepoRelativePath('b.ts'),
    fromComponent: toComponentName('api'),
    toComponent: toComponentName('ui'),
    specifier: './b',
    line: 1,
  };
}

describe('componentOfViolation', () => {
  it("returns the offending file's own component for no-dependency", () => {
    expect(componentOfViolation(noDependencyViolation('v1'))).toBe('api');
  });
});

describe('telemetryStateEntryOf', () => {
  it('narrows a Violation to paths + rule ids only, never file contents', () => {
    const entry = telemetryStateEntryOf(noDependencyViolation('v1'));
    expect(entry).toEqual({ fingerprint: 'v1', ruleId: 'r1', file: 'a.ts', component: 'api' });
  });
});

describe('diffViolationState', () => {
  it('reports no transitions when the state is unchanged', () => {
    const entries = [telemetryStateEntryOf(noDependencyViolation('v1'))];
    const diff = diffViolationState(entries, entries);
    expect(diff.appeared).toEqual([]);
    expect(diff.resolved).toEqual([]);
  });

  it('reports an appeared entry for a new fingerprint', () => {
    const previous: ReturnType<typeof telemetryStateEntryOf>[] = [];
    const current = [telemetryStateEntryOf(noDependencyViolation('v1'))];
    const diff = diffViolationState(previous, current);
    expect(diff.appeared).toHaveLength(1);
    expect(diff.appeared[0]?.fingerprint).toBe('v1');
    expect(diff.resolved).toEqual([]);
  });

  it('reports a resolved entry for a fingerprint that disappeared', () => {
    const previous = [telemetryStateEntryOf(noDependencyViolation('v1'))];
    const current: ReturnType<typeof telemetryStateEntryOf>[] = [];
    const diff = diffViolationState(previous, current);
    expect(diff.resolved).toHaveLength(1);
    expect(diff.resolved[0]?.fingerprint).toBe('v1');
    expect(diff.appeared).toEqual([]);
  });

  it('diffs by fingerprint only, ignoring an unrelated line-number-like change to file text', () => {
    const previous = [telemetryStateEntryOf(noDependencyViolation('v1', 'a.ts'))];
    const current = [telemetryStateEntryOf(noDependencyViolation('v1', 'a.ts'))];
    const diff = diffViolationState(previous, current);
    expect(diff.appeared).toEqual([]);
    expect(diff.resolved).toEqual([]);
  });

  it('computes appear+resolve together for a mixed change', () => {
    const previous = [telemetryStateEntryOf(noDependencyViolation('v1'))];
    const current = [telemetryStateEntryOf(noDependencyViolation('v2'))];
    const diff = diffViolationState(previous, current);
    expect(diff.appeared.map((e) => e.fingerprint)).toEqual(['v2']);
    expect(diff.resolved.map((e) => e.fingerprint)).toEqual(['v1']);
  });
});
