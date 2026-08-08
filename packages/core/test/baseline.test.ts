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
    const result = store.prune([], new Set());
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

  // FRAGILE #8 (bug hunt 2026-08-03): `accept` records the measured value at acceptance time,
  // but ONLY for kinds that carry one — never invented for kinds that have none.
  describe('acceptedValue (FRAGILE #8 growth-advisory support)', () => {
    it('records acceptedValue from a metric-kind violation', () => {
      const store = new InMemoryBaselineStore();
      const v = makeViolation({
        id: computeFingerprint(['metric', 'r1', 'api/big.ts']),
        kind: 'metric',
        metric: 'loc',
        component: toComponentName('api'),
        value: 900,
        threshold: 800,
        fixHint: { code: 'split-file', file: toRepoRelativePath('api/big.ts') },
      });
      store.accept([v], 'manual');
      expect(store.show()[0]?.acceptedValue).toBe(900);
    });

    it('does not record acceptedValue for a non-metric violation', () => {
      const store = new InMemoryBaselineStore();
      const v = makeViolation(); // default kind: 'no-dependency', which has no `value` field
      store.accept([v], 'manual');
      expect(store.show()[0]?.acceptedValue).toBeUndefined();
    });

    it('carries acceptedValue forward across a move-transfer (renamed file, same accepted debt)', () => {
      const store = new InMemoryBaselineStore();
      const original = makeViolation({
        id: computeFingerprint(['metric', 'r1', 'api/big.ts']),
        kind: 'metric',
        metric: 'loc',
        component: toComponentName('api'),
        value: 900,
        threshold: 800,
        fixHint: { code: 'split-file', file: toRepoRelativePath('api/big.ts') },
        snippet: '// api/big.ts',
      });
      store.accept([original], 'manual');

      const moved = makeViolation({
        id: computeFingerprint(['metric', 'r1', 'api/renamed.ts']),
        kind: 'metric',
        metric: 'loc',
        component: toComponentName('api'),
        file: toRepoRelativePath('api/renamed.ts'),
        value: 900,
        threshold: 800,
        fixHint: { code: 'split-file', file: toRepoRelativePath('api/renamed.ts') },
        snippet: '// api/big.ts', // same content — this is what makes it a "move" to reconcileMoves
      });

      store.reconcileMoves([moved], new Set([toRepoRelativePath('api/renamed.ts')]));
      expect(store.isBaselined(moved.id)).toBe(true);
      expect(store.show()[0]?.acceptedValue).toBe(900);
    });
  });
});

describe('baseline move-transfer (ADR 006)', () => {
  it('reconcileMoves transfers an orphaned entry to a same-snippet violation in a different file', () => {
    const store = new InMemoryBaselineStore();
    const original = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']),
      file: toRepoRelativePath('a.ts'),
      snippet: `import './b'`,
    });
    store.accept([original], 'manual');

    // "a.ts" was renamed to "renamed.ts" — same snippet/content, new structural fingerprint. The
    // current scan's known files are exactly what it produced: "renamed.ts" (and whatever else),
    // NOT "a.ts" — that absence is what makes this a rename, not a fix (ADR 006's whole purpose).
    const moved = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'renamed.ts', 'b.ts', './b']),
      file: toRepoRelativePath('renamed.ts'),
      snippet: `import './b'`,
    });

    const result = store.reconcileMoves([moved], new Set([toRepoRelativePath('renamed.ts')]));
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

    // "a.ts" renamed to "renamed.ts" (still absent from knownFiles below); "c.ts" is genuinely
    // fixed — its file is still known, so even without a content match it would stay unmatched.
    const moved = makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', 'renamed.ts', 'b.ts', './b']),
      file: toRepoRelativePath('renamed.ts'),
      snippet: `import './b'`,
    });

    const result = store.prune([moved], new Set([toRepoRelativePath('renamed.ts'), toRepoRelativePath('c.ts')]));
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

    const moved = store.reconcileMoves(
      [original, secondLocation],
      new Set([toRepoRelativePath('a.ts'), toRepoRelativePath('z.ts')]),
    );
    expect(moved).toEqual([]);
    expect(store.isBaselined(original.id)).toBe(true);
    expect(store.isBaselined(secondLocation.id)).toBe(false); // new violation surfaces as red
  });

  it('an entry with no content-fingerprint match on prune is removed, not silently kept', () => {
    const store = new InMemoryBaselineStore();
    const original = makeViolation({ id: computeFingerprint(['a']), snippet: 'unique-a' });
    store.accept([original], 'manual');
    const result = store.prune([], new Set());
    expect(result.moved).toEqual([]);
    expect(result.removed).toEqual([original.id]);
  });

  // FRAGILE #7 (bug hunt 2026-08-03): the case ADR 006's original design comment didn't cover — a
  // fixed violation coexisting, in the same scan, with a textually identical NEW violation
  // elsewhere. The fix: transfer only when the orphan's OWN file is no longer in the current scan.
  describe('FRAGILE #7 fix: file-existence gating', () => {
    it('does NOT transfer when the orphan\'s own file still exists (violation there was fixed, not moved)', () => {
      const store = new InMemoryBaselineStore();
      const original = makeViolation({
        id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'target.ts', './target']),
        file: toRepoRelativePath('a.ts'),
        snippet: `import './target'`,
      });
      store.accept([original], 'manual');

      // a.ts's violating import was removed (fixed) but a.ts itself is still scanned. b.ts is a
      // different, brand-new file that happens to add a textually identical import in the same
      // commit — a routine refactor/copy-paste, not a rename.
      const newViolation = makeViolation({
        id: computeFingerprint(['no-dependency', 'r1', 'b.ts', 'target.ts', './target']),
        file: toRepoRelativePath('b.ts'),
        snippet: `import './target'`,
      });

      const knownFiles = new Set([toRepoRelativePath('a.ts'), toRepoRelativePath('b.ts')]);
      const result = store.reconcileMoves([newViolation], knownFiles);

      expect(result).toEqual([]);
      expect(store.isBaselined(newViolation.id)).toBe(false); // b.ts's violation shows red
      expect(store.isBaselined(original.id)).toBe(true); // orphan left in place (reconcileMoves never deletes)
    });

    it('the rename case still transfers (ADR 006 unaffected): orphan file absent, identical content elsewhere', () => {
      const store = new InMemoryBaselineStore();
      const original = makeViolation({
        id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'target.ts', './target']),
        file: toRepoRelativePath('a.ts'),
        snippet: `import './target'`,
      });
      store.accept([original], 'manual');

      // "a.ts" was renamed to "c.ts" — absent from this scan's knownFiles entirely.
      const moved = makeViolation({
        id: computeFingerprint(['no-dependency', 'r1', 'c.ts', 'target.ts', './target']),
        file: toRepoRelativePath('c.ts'),
        snippet: `import './target'`,
      });

      const result = store.reconcileMoves([moved], new Set([toRepoRelativePath('c.ts')]));
      expect(result).toEqual([{ from: original.id, to: moved.id }]);
      expect(store.isBaselined(moved.id)).toBe(true);
      expect(store.isBaselined(original.id)).toBe(false);
    });

    it('an orphan whose file is gone but has no matching candidate stays an unmatched orphan (unchanged)', () => {
      const store = new InMemoryBaselineStore();
      const original = makeViolation({
        id: computeFingerprint(['a']),
        file: toRepoRelativePath('a.ts'),
        snippet: 'unique-a',
      });
      store.accept([original], 'manual');

      // a.ts is gone from this scan, but nothing currently matches its content fingerprint —
      // reconcileMoves must leave it exactly as it was (deletion is prune's job, not this one's).
      const result = store.reconcileMoves([], new Set());
      expect(result).toEqual([]);
      expect(store.isBaselined(original.id)).toBe(true);
      expect(store.show()).toHaveLength(1);
    });

    it('two orphans competing for one content-matching candidate: only one is consumed (existing splice behaviour)', () => {
      const store = new InMemoryBaselineStore();
      const original1 = makeViolation({
        id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'target.ts', './target']),
        file: toRepoRelativePath('a.ts'),
        snippet: `import './target'`,
      });
      const original2 = makeViolation({
        id: computeFingerprint(['no-dependency', 'r1', 'c.ts', 'target.ts', './target']),
        file: toRepoRelativePath('c.ts'),
        snippet: `import './target'`,
      });
      store.accept([original1, original2], 'manual');

      // Both a.ts and c.ts are gone (renamed away); only one current violation shares their
      // content fingerprint, so only one orphan can claim it.
      const candidate = makeViolation({
        id: computeFingerprint(['no-dependency', 'r1', 'd.ts', 'target.ts', './target']),
        file: toRepoRelativePath('d.ts'),
        snippet: `import './target'`,
      });

      const result = store.reconcileMoves([candidate], new Set([toRepoRelativePath('d.ts')]));
      expect(result).toHaveLength(1);
      expect(result[0]?.to).toBe(candidate.id);
      expect(store.isBaselined(candidate.id)).toBe(true);

      const remainingOrphanId = result[0]?.from === original1.id ? original2.id : original1.id;
      expect(store.isBaselined(remainingOrphanId)).toBe(true); // still keyed under its own (orphaned) fingerprint — untouched
      expect(store.show()).toHaveLength(2); // the transferred entry + the still-unmatched orphan
    });
  });
});
