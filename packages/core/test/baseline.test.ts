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
    const result = store.prune({ nodes: [], edges: [], externalNodes: [], externalEdges: [], uncertain: [], scannedAt: Date.now() }, []);
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

describe('baseline move-transfer (ADR 006)', () => {
  const emptyGraph = { nodes: [], edges: [], externalNodes: [], externalEdges: [], uncertain: [], scannedAt: Date.now() };

  it('reconcileMoves transfers an orphaned entry to a same-snippet violation in a different file', () => {
    const store = new InMemoryBaselineStore();
    const original = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']),
      file: toRepoRelativePath('a.ts'),
      snippet: `import './b'`,
    });
    store.accept([original], 'manual');

    // "a.ts" was renamed to "renamed.ts" — same snippet/content, new structural fingerprint.
    const moved = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'renamed.ts', 'b.ts', './b']),
      file: toRepoRelativePath('renamed.ts'),
      snippet: `import './b'`,
    });

    const result = store.reconcileMoves([moved]);
    expect(result).toEqual([{ from: original.id, to: moved.id }]);
    expect(store.isBaselined(moved.id)).toBe(true);
    expect(store.isBaselined(original.id)).toBe(false);
    expect(store.show()[0]?.file).toBe('renamed.ts');
  });

  it('prune transfers moves and removes only genuinely-fixed entries in the same pass', () => {
    const store = new InMemoryBaselineStore();
    const original = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']),
      file: toRepoRelativePath('a.ts'),
      snippet: `import './b'`,
    });
    const fixedElsewhere = makeViolation({
      id: computeFingerprint(['no-dependency', 'r2', 'c.ts', 'd.ts', './d']),
      ruleId: toRuleId('r2'),
      file: toRepoRelativePath('c.ts'),
      snippet: `import './d'`,
    });
    store.accept([original, fixedElsewhere], 'manual');

    const moved = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'renamed.ts', 'b.ts', './b']),
      file: toRepoRelativePath('renamed.ts'),
      snippet: `import './b'`,
    });

    const result = store.prune(emptyGraph, [moved]);
    expect(result.moved).toEqual([{ from: original.id, to: moved.id }]);
    expect(result.removed).toEqual([fixedElsewhere.id]);
    expect(store.isBaselined(moved.id)).toBe(true);
    expect(store.isBaselined(fixedElsewhere.id)).toBe(false);
  });

  it('does NOT swallow a genuinely new identical-snippet violation while the original still exists', () => {
    const store = new InMemoryBaselineStore();
    const original = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']),
      file: toRepoRelativePath('a.ts'),
      snippet: `import './b'`,
    });
    store.accept([original], 'manual');

    // Original is untouched (still present) AND a second, unrelated location has an identical
    // snippet+rule violation — both fingerprints must remain live and distinct.
    const secondLocation = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'z.ts', 'b.ts', './b']),
      file: toRepoRelativePath('z.ts'),
      snippet: `import './b'`,
    });

    const moved = store.reconcileMoves([original, secondLocation]);
    expect(moved).toEqual([]);
    expect(store.isBaselined(original.id)).toBe(true);
    expect(store.isBaselined(secondLocation.id)).toBe(false); // new violation surfaces as red
  });

  it('an entry with no content-fingerprint match on prune is removed, not silently kept', () => {
    const store = new InMemoryBaselineStore();
    const original = makeViolation({ id: computeFingerprint(['a']), snippet: 'unique-a' });
    store.accept([original], 'manual');
    const result = store.prune(emptyGraph, []);
    expect(result.moved).toEqual([]);
    expect(result.removed).toEqual([original.id]);
  });
});
