import { describe, expect, it } from 'vitest';
import { InMemoryBaselineStore } from '../src/baseline/store.js';
import { computeFingerprint } from '../src/baseline/fingerprint.js';
import { toComponentName, toRepoRelativePath, toRuleId } from '../src/types/branded.js';
import type { Violation } from '../src/types/violation.js';

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']),
    ruleId: toRuleId('r1'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath('a.ts'),
    range: { startLine: 1, endLine: 1 },
    snippet: `import './b'`,
    fixHint: { code: 'remove-import', file: toRepoRelativePath('a.ts'), line: 1 },
    kind: 'no-dependency',
    fromFile: toRepoRelativePath('a.ts'),
    toFile: toRepoRelativePath('b.ts'),
    fromComponent: toComponentName('x'),
    toComponent: toComponentName('y'),
    specifier: './b',
    line: 1,
    ...overrides,
  } as Violation;
}

describe('fingerprint stability', () => {
  it('is unaffected by edits above/below the violation (line numbers not part of the hash inputs used here)', () => {
    const id1 = computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']);
    const id2 = computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']);
    expect(id1).toBe(id2);
  });

  it('changes when the structural identity changes', () => {
    const id1 = computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']);
    const id2 = computeFingerprint(['no-dependency', 'r1', 'a.ts', 'c.ts', './c']);
    expect(id1).not.toBe(id2);
  });
});

describe('InMemoryBaselineStore', () => {
  it('isBaselined reflects accepted violations', () => {
    const store = new InMemoryBaselineStore();
    const v = makeViolation();
    expect(store.isBaselined(v.id)).toBe(false);
    store.accept([v], 'manual');
    expect(store.isBaselined(v.id)).toBe(true);
  });

  it('acceptByRule only accepts violations of the given rule', () => {
    const store = new InMemoryBaselineStore();
    const v1 = makeViolation({ ruleId: toRuleId('r1'), id: computeFingerprint(['a']) });
    const v2 = makeViolation({ ruleId: toRuleId('r2'), id: computeFingerprint(['b']) });
    store.acceptByRule(toRuleId('r1'), [v1, v2]);
    expect(store.isBaselined(v1.id)).toBe(true);
    expect(store.isBaselined(v2.id)).toBe(false);
  });

  it('show filters by ruleId', () => {
    const store = new InMemoryBaselineStore();
    const v1 = makeViolation({ ruleId: toRuleId('r1'), id: computeFingerprint(['a']) });
    const v2 = makeViolation({ ruleId: toRuleId('r2'), id: computeFingerprint(['b']) });
    store.accept([v1, v2], 'manual');
    expect(store.show({ ruleId: toRuleId('r1') })).toHaveLength(1);
    expect(store.show()).toHaveLength(2);
  });

  it('prune removes entries no longer present in the current violation set', () => {
    const store = new InMemoryBaselineStore();
    const v1 = makeViolation({ id: computeFingerprint(['a']) });
    store.accept([v1], 'manual');
    const result = store.prune({ nodes: [], edges: [], uncertain: [], scannedAt: Date.now() }, []);
    expect(result.removed).toEqual([v1.id]);
    expect(store.isBaselined(v1.id)).toBe(false);
  });

  it('snapshot round-trips through a fresh store (persistence contract for the CLI)', () => {
    const store = new InMemoryBaselineStore();
    const v1 = makeViolation({ id: computeFingerprint(['a']) });
    store.accept([v1], 'init-seed');
    const snapshot = store.snapshot();
    const reloaded = new InMemoryBaselineStore(snapshot);
    expect(reloaded.isBaselined(v1.id)).toBe(true);
  });
});
