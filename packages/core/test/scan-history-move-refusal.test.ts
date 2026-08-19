import { describe, expect, it } from 'vitest';
import { InMemoryBaselineStore } from '../src/baseline/store.js';
import { createScanHistoryProbe, noScanHistory } from '../src/baseline/scan-history.js';
import { computeContentFingerprint, computeFingerprint } from '../src/baseline/fingerprint.js';
import { toComponentName, toRepoRelativePath, toRuleId } from '../src/types/branded.js';
import type { RepoRelativePath } from '../src/types/branded.js';
import type { ScanHistoryContext, ScanObservationRecord } from '../src/types/scan-history.js';
import type { Violation } from '../src/types/violation.js';
import { neverOnDisk } from './helpers.js';

/**
 * ADR 029 §6's first consumer, and the close of LEDGER **D015** — the last open severity zero.
 *
 * THE DEFECT. Baseline a violation at `src/api/old.ts`. Add a content-identical, never-reviewed
 * violation at `src/api/new.ts` (the repository is now red). Delete `old.ts`. `applyMoves` sees the
 * orphan's own file gone plus a content-fingerprint match, calls it a rename, and moves the human's
 * `acceptedAt`/`acceptedBy` onto the violation nobody looked at — a plain `align check` goes red →
 * **green** and exits 0. Every existing guard behaves correctly: ADR 006 *requires* transfers,
 * FRAGILE #7's test is about the orphan's file and passes, ADR 028 mechanism 3 is directory-granular
 * and `src/api/` still exists. No single snapshot separates it from a rename, because
 * `contentFingerprint` IS identity here.
 *
 * THE FIX. A second snapshot. `wasViolationObservedAt` asks whether the PREVIOUS scan already
 * reported this violation at this path; if it did, the candidate existed before the orphan's file
 * disappeared and therefore cannot be where the violation moved to.
 *
 * **The first two tests are the red and the green of the same fixture**, run against the same store
 * with only the probe swapped — so the reproduction is not a claim in this comment, it is the
 * `noScanHistory()` case sitting next to the real one. If the defect ever stops reproducing, the
 * first test fails and says so, rather than the second passing vacuously [S-05].
 */

const RULE = toRuleId('arch.no-dependency:api-to-db');
const SNIPPET = `import { db } from '../db'`;

function makeViolation(file: string, overrides: Partial<Violation> = {}): Violation {
  return {
    id: computeFingerprint(['no-dependency', RULE, file, 'src/db/index.ts', '../db']),
    ruleId: RULE,
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath(file),
    range: { startLine: 1, endLine: 1 },
    snippet: SNIPPET,
    fixHint: { code: 'remove-import', file: toRepoRelativePath(file), line: 1 },
    kind: 'no-dependency',
    fromFile: toRepoRelativePath(file),
    toFile: toRepoRelativePath('src/db/index.ts'),
    fromComponent: toComponentName('api'),
    toComponent: toComponentName('db'),
    specifier: '../db',
    line: 1,
  } as Violation;
}

const OLD = 'src/api/old.ts';
const NEW = 'src/api/new.ts';
const RULE_HASH = 'rule-hash-1';

/** The current scan's half of ADR 029 §4's comparisons. Built by hand rather than from a
 * `RulesetIR` so that each invalidation predicate can be driven directly — the predicates
 * themselves are pinned against real rulesets in `scan-history-probe.test.ts`. */
function context(overrides: Partial<ScanHistoryContext> = {}): ScanHistoryContext {
  return {
    alignVersion: '0.2.0',
    scopeIdentity: 'scope-1',
    ruleDefinitions: new Map([[RULE, RULE_HASH]]),
    componentSelectorIdentities: new Map(),
    ...overrides,
  };
}

/** A record in which the previous scan observed `violatingFiles` as violating this rule with this
 * snippet. `observed` lists the same paths so the record is internally consistent, though
 * `wasViolationObservedAt` reads only `violations`. */
function record(violatingFiles: readonly string[], overrides: Partial<ScanObservationRecord> = {}): ScanObservationRecord {
  return {
    recordVersion: 1,
    alignVersion: '0.2.0',
    scopeIdentity: 'scope-1',
    observedAt: 1_755_000_000_000,
    observed: { source: violatingFiles.map(toRepoRelativePath), manifest: [] },
    components: {},
    ruleDefinitions: { [RULE]: RULE_HASH },
    violations: violatingFiles.map((file) => ({
      file: toRepoRelativePath(file),
      ruleId: RULE,
      contentFingerprint: computeContentFingerprint(RULE, SNIPPET),
    })),
    ...overrides,
  };
}

/** The D015 fixture: `OLD` accepted, `NEW` live and never accepted, `OLD`'s file gone from the scan
 * while its directory is still observed — so ADR 028 mechanism 3 does not fire and the transfer arm
 * is genuinely reached. */
function stage(probe = noScanHistory()) {
  const accepted = makeViolation(OLD);
  const store = new InMemoryBaselineStore([], neverOnDisk, probe);
  store.accept([accepted], 'manual');
  const live = makeViolation(NEW);
  const knownFiles = new Set<RepoRelativePath>([toRepoRelativePath(NEW)]);
  return { store, live, knownFiles };
}

describe('a candidate the previous scan already reported is never a move target (LEDGER D015)', () => {
  it('reproduces the forged transfer when there is no history to consult', () => {
    // NOT a regression test for behaviour we want — this is the defect, pinned so that the test
    // below cannot pass because the fixture stopped reaching `applyMoves`' content-match arm.
    const { store, live, knownFiles } = stage();

    const moved = store.reconcileMoves([live], knownFiles, []);

    expect(moved).toHaveLength(1);
    expect(store.show().map((e) => e.file)).toEqual([NEW]);
    expect(store.show()[0]?.acceptedBy).toBe('manual');
  });

  it('refuses the transfer when the previous scan already reported that violation at that path', () => {
    const probe = createScanHistoryProbe(record([OLD, NEW]), context());
    const { store, live, knownFiles } = stage(probe);

    const moved = store.reconcileMoves([live], knownFiles, []);

    expect(moved).toEqual([]);
    // Retention, not deletion: `reconcileMoves` leaves an unmatched orphan alone, so the human's
    // acceptance stays where they put it and the live violation at NEW stays red and reviewable.
    expect(store.show().map((e) => e.file)).toEqual([OLD]);
    expect(store.isBaselined(live.id)).toBe(false);
  });

  it('still transfers a genuine rename — the candidate was not observed last scan', () => {
    // ADR 006's guarantee, unchanged: the previous scan saw the violation at OLD and nothing at NEW,
    // which is what a rename looks like. A refusal here would be the false-refusal cost §7.3 warns
    // about, and it is the assertion that stops this mechanism from being tightened into one.
    const probe = createScanHistoryProbe(record([OLD]), context());
    const { store, live, knownFiles } = stage(probe);

    const moved = store.reconcileMoves([live], knownFiles, []);

    expect(moved).toHaveLength(1);
    expect(store.show().map((e) => e.file)).toEqual([NEW]);
  });

  it('takes the next candidate when the first is already-observed, rather than refusing the orphan', () => {
    // Two live violations share the content fingerprint; only one was there last scan. Refusing per
    // ORPHAN instead of per CANDIDATE would strand the entry even though a sound move target exists.
    const probe = createScanHistoryProbe(record([OLD, NEW]), context());
    const { store, knownFiles } = stage(probe);
    const alsoNew = makeViolation('src/api/newer.ts');
    knownFiles.add(toRepoRelativePath('src/api/newer.ts'));

    const moved = store.reconcileMoves([makeViolation(NEW), alsoNew], knownFiles, []);

    expect(moved.map((m) => m.toFile)).toEqual(['src/api/newer.ts']);
    expect(store.show().map((e) => e.file)).toEqual(['src/api/newer.ts']);
  });
});

describe('under `prune`, a refused transfer is a deletion — stated because it is not obvious', () => {
  it('removes the orphan instead of transferring it, and leaves the candidate unbaselined', () => {
    // `reconcileMoves` and `prune` share `applyMoves` and differ only in what happens to an orphan
    // with no match: left alone, or deleted. So the refusal routes a D015 orphan into `prune`'s
    // DELETE arm — which is correct (the file really is gone, and removing stale entries is what
    // `prune` is for, behind consent and ADR 023's guards) but is a destructive consequence of a
    // safety mechanism, and nobody should have to derive it from two doc comments.
    const probe = createScanHistoryProbe(record([OLD, NEW]), context());
    const { store, live, knownFiles } = stage(probe);

    const result = store.prune([live], knownFiles, []);

    expect(result.moved).toEqual([]);
    expect(result.removed).toHaveLength(1);
    expect(store.show()).toEqual([]);
    expect(store.isBaselined(live.id)).toBe(false);
  });
});

describe('every way the history can decline to answer leaves the transfer exactly as it was', () => {
  // ADR 029 §5, as a property rather than as a sentence: `known: false` must collapse to the
  // behaviour align had before this mechanism existed. Table-driven because the property is a
  // UNIVERSAL over the invalidation predicates — a per-case test invites the next predicate to be
  // added without a case.
  const DECLINES: readonly { readonly why: string; readonly probe: () => ReturnType<typeof createScanHistoryProbe> }[] = [
    { why: 'there is no record at all', probe: () => createScanHistoryProbe(undefined, context()) },
    {
      why: 'the record was written by a different align version',
      probe: () => createScanHistoryProbe(record([OLD, NEW], { alignVersion: '0.1.9' }), context()),
    },
    {
      why: "the cited rule's definition has changed since",
      probe: () => createScanHistoryProbe(record([OLD, NEW]), context({ ruleDefinitions: new Map([[RULE, 'rule-hash-2']]) })),
    },
    {
      why: 'the cited rule no longer exists in the current ruleset',
      probe: () => createScanHistoryProbe(record([OLD, NEW]), context({ ruleDefinitions: new Map() })),
    },
  ];

  for (const { why, probe } of DECLINES) {
    it(`transfers as it did before ADR 029 when ${why}`, () => {
      const { store, live, knownFiles } = stage(probe());

      expect(store.reconcileMoves([live], knownFiles, [])).toHaveLength(1);
    });
  }

  it('answers about a scan scope that has changed since, because the recollection is positive', () => {
    // The one asymmetry worth pinning HERE rather than only in `scan-history-probe.test.ts`, because
    // this is the consumer it was designed for: `wasViolationObservedAt` deliberately does not gate
    // on `scopeIdentity`. Narrowing or widening `excludes` cannot make a violation align actually
    // reported stop having been reported, and discarding that answer would reopen D015 for every
    // user who edited their config between two runs.
    const probe = createScanHistoryProbe(record([OLD, NEW], { scopeIdentity: 'scope-0' }), context());
    const { store, live, knownFiles } = stage(probe);

    expect(store.reconcileMoves([live], knownFiles, [])).toEqual([]);
  });
});
