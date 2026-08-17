import { describe, expect, it } from 'vitest';
import { InMemoryBaselineStore } from '../src/baseline/store.js';
import { computeFingerprint } from '../src/baseline/fingerprint.js';
import { toComponentName, toRepoRelativePath, toRuleId } from '../src/types/branded.js';
import type { ScanBlindSpotReason } from '../src/types/graph.js';
import type { Violation } from '../src/types/violation.js';
import { blindSpot, neverOnDisk, onDisk } from './helpers.js';

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
    const store = new InMemoryBaselineStore([], neverOnDisk);
    const v = makeViolation();
    expect(store.isBaselined(v.id)).toBe(false);
    store.accept([v], 'manual');
    expect(store.isBaselined(v.id)).toBe(true);
  });

  it('acceptByRule only accepts violations of the given rule', () => {
    const store = new InMemoryBaselineStore([], neverOnDisk);
    const v1 = makeViolation({ ruleId: toRuleId('r1'), id: computeFingerprint(['a']) });
    const v2 = makeViolation({ ruleId: toRuleId('r2'), id: computeFingerprint(['b']) });
    store.acceptByRule(toRuleId('r1'), [v1, v2]);
    expect(store.isBaselined(v1.id)).toBe(true);
    expect(store.isBaselined(v2.id)).toBe(false);
  });

  it('show filters by ruleId', () => {
    const store = new InMemoryBaselineStore([], neverOnDisk);
    const v1 = makeViolation({ ruleId: toRuleId('r1'), id: computeFingerprint(['a']) });
    const v2 = makeViolation({ ruleId: toRuleId('r2'), id: computeFingerprint(['b']) });
    store.accept([v1, v2], 'manual');
    expect(store.show({ ruleId: toRuleId('r1') })).toHaveLength(1);
    expect(store.show()).toHaveLength(2);
  });

  it('prune removes entries no longer present in the current violation set', () => {
    const store = new InMemoryBaselineStore([], neverOnDisk);
    const v1 = makeViolation({ id: computeFingerprint(['a']) });
    store.accept([v1], 'manual');
    const result = store.prune([], new Set());
    expect(result.removed).toEqual([v1.id]);
    expect(store.isBaselined(v1.id)).toBe(false);
  });

  it('snapshot round-trips through a fresh store (persistence contract for the CLI)', () => {
    const store = new InMemoryBaselineStore([], neverOnDisk);
    const v1 = makeViolation({ id: computeFingerprint(['a']) });
    store.accept([v1], 'init-seed');
    const snapshot = store.snapshot();
    const reloaded = new InMemoryBaselineStore(snapshot, neverOnDisk);
    expect(reloaded.isBaselined(v1.id)).toBe(true);
  });

  // FRAGILE #8 (bug hunt 2026-08-03): `accept` records the measured value at acceptance time,
  // but ONLY for kinds that carry one — never invented for kinds that have none.
  describe('acceptedValue (FRAGILE #8 growth-advisory support)', () => {
    it('records acceptedValue from a metric-kind violation', () => {
      const store = new InMemoryBaselineStore([], neverOnDisk);
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
      const store = new InMemoryBaselineStore([], neverOnDisk);
      const v = makeViolation(); // default kind: 'no-dependency', which has no `value` field
      store.accept([v], 'manual');
      expect(store.show()[0]?.acceptedValue).toBeUndefined();
    });

    it('carries acceptedValue forward across a move-transfer (renamed file, same accepted debt)', () => {
      const store = new InMemoryBaselineStore([], neverOnDisk);
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
    const store = new InMemoryBaselineStore([], neverOnDisk);
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
    const store = new InMemoryBaselineStore([], neverOnDisk);
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
    const store = new InMemoryBaselineStore([], neverOnDisk);
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
    const store = new InMemoryBaselineStore([], neverOnDisk);
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
      const store = new InMemoryBaselineStore([], neverOnDisk);
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
      const store = new InMemoryBaselineStore([], neverOnDisk);
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
      const store = new InMemoryBaselineStore([], neverOnDisk);
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

    // F1 (ADR 027's forged-transfer fix, generalized by ADR 028): a file the scan declined to look
    // at — for ANY reason recorded in `CheckRun.blindSpots` — is absent from
    // `knownFiles` for a reason that has nothing to do with the file moving. Before this fix,
    // `applyMoves` read that absence exactly like a real rename/deletion and went looking for a
    // content-fingerprint match — which a vendored copy of the same code (same ruleId, identical
    // trimmed import line) reliably provides, forging the orphan's `acceptedAt`/`acceptedBy` onto a
    // live, never-accepted violation elsewhere.
    describe('F1 fix: an orphan under a scan blind spot is never mistaken for a move', () => {
      it('reconcileMoves leaves a checkout-resident orphan in place instead of transferring it onto a colliding, never-accepted violation', () => {
        const store = new InMemoryBaselineStore([], neverOnDisk);
        const original = makeViolation({
          id: computeFingerprint(['no-dependency', 'r1', 'vendor/submodule/service.ts', 'target.ts', './target']),
          file: toRepoRelativePath('vendor/submodule/service.ts'),
          snippet: `import './target'`,
        });
        store.accept([original], 'manual');

        // A live, NEVER-accepted violation with an identical content fingerprint (same ruleId +
        // snippet) in a different file — the expected shape for a vendored copy of the same import.
        const liveUnaccepted = makeViolation({
          id: computeFingerprint(['no-dependency', 'r1', 'lib/service.ts', 'target.ts', './target']),
          file: toRepoRelativePath('lib/service.ts'),
          snippet: `import './target'`,
        });

        // `vendor/submodule/service.ts` is absent from `knownFiles` (the scan auto-excluded the
        // checkout) but the checkout is a recorded blind spot — the "still known" signal this fix
        // adds.
        const knownFiles = new Set([toRepoRelativePath('lib/service.ts')]);
        const result = store.reconcileMoves([liveUnaccepted], knownFiles, [blindSpot('vendor/submodule')]);

        expect(result).toEqual([]); // no forged transfer reported
        expect(store.isBaselined(liveUnaccepted.id)).toBe(false); // lib/service.ts still shows red
        expect(store.isBaselined(original.id)).toBe(true); // orphan untouched — same fingerprint, same entry
        expect(store.show()[0]?.acceptedBy).toBe('manual');
        expect(store.show()[0]?.file).toBe('vendor/submodule/service.ts'); // provenance never moved
      });

      it('prune classifies the checkout-resident orphan as removed, not moved — the arm the CLI\'s retention partition protects', () => {
        const store = new InMemoryBaselineStore([], neverOnDisk);
        const original = makeViolation({
          id: computeFingerprint(['no-dependency', 'r1', 'vendor/submodule/service.ts', 'target.ts', './target']),
          file: toRepoRelativePath('vendor/submodule/service.ts'),
          snippet: `import './target'`,
        });
        store.accept([original], 'manual');

        const liveUnaccepted = makeViolation({
          id: computeFingerprint(['no-dependency', 'r1', 'lib/service.ts', 'target.ts', './target']),
          file: toRepoRelativePath('lib/service.ts'),
          snippet: `import './target'`,
        });

        const knownFiles = new Set([toRepoRelativePath('lib/service.ts')]);
        const result = store.prune([liveUnaccepted], knownFiles, [blindSpot('vendor/submodule')]);

        // Landed in `removed` (the arm `scan-blind-spot-retention.ts` partitions and re-adds),
        // never in `moved` — this is the property the CLI's retention logic depends on.
        expect(result.moved).toEqual([]);
        expect(result.removed).toEqual([original.id]);
        expect(store.isBaselined(liveUnaccepted.id)).toBe(false); // never silently pre-accepted
      });

      it('a genuine rename outside any skipped checkout still transfers (no regression of FRAGILE #7)', () => {
        const store = new InMemoryBaselineStore([], neverOnDisk);
        const original = makeViolation({
          id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'target.ts', './target']),
          file: toRepoRelativePath('a.ts'),
          snippet: `import './target'`,
        });
        store.accept([original], 'manual');

        // "a.ts" renamed to "renamed.ts" — absent from knownFiles entirely, and unrelated to any
        // skipped checkout (an unrelated checkout path is passed to prove the new parameter is
        // scoped, not a blanket suppression of move detection).
        const moved = makeViolation({
          id: computeFingerprint(['no-dependency', 'r1', 'renamed.ts', 'target.ts', './target']),
          file: toRepoRelativePath('renamed.ts'),
          snippet: `import './target'`,
        });

        const result = store.reconcileMoves(
          [moved],
          new Set([toRepoRelativePath('renamed.ts')]),
          [blindSpot('vendor/unrelated-checkout')],
        );
        expect(result).toEqual([{ from: original.id, to: moved.id }]);
        expect(store.isBaselined(moved.id)).toBe(true);
        expect(store.isBaselined(original.id)).toBe(false);
      });

      // ADR 028: the same protection, once per `ScanBlindSpotReason` variant. Keyed by the union so
      // adding a variant without deciding its retention behaviour fails the build here — the
      // enforcement ADR 028 asks for, since the previous enumeration (ADR 027) covered only
      // `nested-checkout` and missed five, two of them reproduced severity-zeros.
      const REASONS: Readonly<Record<ScanBlindSpotReason['kind'], ScanBlindSpotReason>> = {
        'nested-checkout': { kind: 'nested-checkout' },
        excluded: { kind: 'excluded', pattern: 'vendor/**' },
        'default-excluded-dir': { kind: 'default-excluded-dir', name: 'dist' },
        unreadable: { kind: 'unreadable', error: 'EACCES: permission denied' },
        'not-regular-file': { kind: 'not-regular-file' },
      };

      for (const [kind, reason] of Object.entries(REASONS)) {
        it(`reason '${kind}': the orphan is retained, never forged onto a colliding live violation`, () => {
          const store = new InMemoryBaselineStore([], neverOnDisk);
          const original = makeViolation({
            id: computeFingerprint(['no-dependency', 'r1', 'vendor/submodule/service.ts', 'target.ts', './target']),
            file: toRepoRelativePath('vendor/submodule/service.ts'),
            snippet: `import './target'`,
          });
          store.accept([original], 'manual');
          const liveUnaccepted = makeViolation({
            id: computeFingerprint(['no-dependency', 'r1', 'lib/service.ts', 'target.ts', './target']),
            file: toRepoRelativePath('lib/service.ts'),
            snippet: `import './target'`,
          });
          const knownFiles = new Set([toRepoRelativePath('lib/service.ts')]);

          const moves = store.reconcileMoves([liveUnaccepted], knownFiles, [blindSpot('vendor/submodule', reason)]);

          expect(moves).toEqual([]);
          expect(store.isBaselined(liveUnaccepted.id)).toBe(false);
          expect(store.show()[0]?.file).toBe('vendor/submodule/service.ts');
          expect(store.show()[0]?.acceptedBy).toBe('manual');
        });
      }

      // The scan ROOT being unreadable records a blind spot whose path is `''`. At-or-under matching
      // over `''` must cover the whole repository — otherwise the one case where align saw NOTHING
      // is the one case where it protects nothing, and `prune` empties the baseline at exit 0.
      it("a blind spot at the repo root ('') covers every path", () => {
        const store = new InMemoryBaselineStore([], neverOnDisk);
        const original = makeViolation({
          id: computeFingerprint(['no-dependency', 'r1', 'src/a.ts', 'target.ts', './target']),
          file: toRepoRelativePath('src/a.ts'),
          snippet: `import './target'`,
        });
        store.accept([original], 'manual');

        const result = store.prune([], new Set(), [blindSpot('', { kind: 'unreadable', error: 'EACCES' })]);

        expect(result.removed).toEqual([original.id]); // classified as orphaned-but-retainable...
        expect(result.moved).toEqual([]); // ...and never forged onto anything
      });
    });

    it('two orphans competing for one content-matching candidate: only one is consumed (existing splice behaviour)', () => {
      const store = new InMemoryBaselineStore([], neverOnDisk);
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

// The consequence half of the `init`-strips-contentFingerprint defect. The CAUSE (init rebuilding
// entries without the field) is pinned end-to-end by
// `integration/scenarios/init-rerun-preserves-content-fingerprint.mjs`; this is the part that makes
// it severity-zero rather than cosmetic, pinned here because the rename can be exact.
//
// These two tests are deliberately identical except for one thing: whether the accepted entry
// carries a `contentFingerprint`. Everything else — the rename, the live violation, `knownFiles` —
// is the same. Before the `init` fix, a re-run of `align init` was exactly the operation that
// turned the first store into the second.
describe('move-transfer depends on contentFingerprint — the two arms of the init-strip defect', () => {
  const ORIGINAL_FILE = 'src/api/old.ts';
  const RENAMED_FILE = 'src/api/new.ts';
  const SNIPPET = `import './target'`;

  /** The same violation after its file was renamed: identical rule and identical snippet, new path.
   * Its `id` differs because the path is one of the fingerprint's inputs — which is precisely why
   * move-transfer needs `contentFingerprint` (rule + snippet, path-independent) to recognize it. */
  function renamedViolation() {
    return makeViolation({
      id: computeFingerprint(['no-dependency', 'r1', RENAMED_FILE, 'target.ts', './target']),
      file: toRepoRelativePath(RENAMED_FILE),
      snippet: SNIPPET,
    });
  }

  const originalId = computeFingerprint(['no-dependency', 'r1', ORIGINAL_FILE, 'target.ts', './target']);
  // The rename means the original path is GONE from the scan — the precondition move-transfer
  // requires (FRAGILE #7: a transfer only fires when the orphan's own file genuinely disappeared).
  const knownFilesAfterRename = new Set([toRepoRelativePath(RENAMED_FILE)]);

  it('WITH contentFingerprint (an entry written by `baseline accept`): the rename is rescued', () => {
    const store = new InMemoryBaselineStore([], neverOnDisk);
    store.accept(
      [makeViolation({ id: originalId, file: toRepoRelativePath(ORIGINAL_FILE), snippet: SNIPPET })],
      'manual',
    );

    const moved = renamedViolation();
    const result = store.prune([moved], knownFilesAfterRename);

    expect(result.moved).toEqual([{ from: originalId, to: moved.id }]);
    expect(result.removed).toEqual([]);
    expect(store.isBaselined(moved.id)).toBe(true); // debt stays accepted at its new path
    expect(store.show()[0]?.acceptedBy).toBe('manual'); // and the human's consent survives the move
  });

  it('WITHOUT contentFingerprint (the same entry after an `init` re-run): prune DELETES it and calls it fixed', () => {
    // Byte-for-byte what `init` used to write: provenance preserved, contentFingerprint dropped.
    const store = new InMemoryBaselineStore([
      {
        fingerprint: originalId,
        ruleId: toRuleId('r1'),
        file: toRepoRelativePath(ORIGINAL_FILE),
        acceptedAt: 1_700_000_000_000,
        acceptedBy: 'manual',
      },
    ], neverOnDisk);

    const moved = renamedViolation();
    const result = store.prune([moved], knownFilesAfterRename);

    // The defect, stated as an assertion: the identical rename is now unrecognizable.
    expect(result.moved).toEqual([]);
    expect(result.removed).toEqual([originalId]); // reported to the user as "fixed"
    expect(store.isBaselined(moved.id)).toBe(false); // ...while the violation is still there, now red
    expect(store.show()).toHaveLength(0); // the consent record is gone, unrecoverably
  });
});
