import { describe, expect, it } from 'vitest';
import {
  buildScanHistoryContext,
  buildScanObservation,
  computeComponentSelectorIdentities,
  computeScopeIdentity,
  createScanHistoryProbe,
  observationsDiffer,
} from '../src/baseline/scan-history.js';
import { defineProject } from '../src/dsl/index.js';
import { toComponentName, toRepoRelativePath, toRuleId, toViolationId } from '../src/types/branded.js';
import type { CheckRun } from '../src/gates/types.js';
import type { ScanObservationRecord } from '../src/types/scan-history.js';

const VERSION = '0.2.0';

/** The ruleset every test below shares unless it deliberately perturbs one field. Two components in
 * declaration order, because the shadowing case is what the prefix-identity design exists for. */
function ruleset(overrides: { readonly apiPattern?: string; readonly uiPattern?: string; readonly maxLoc?: number } = {}) {
  return defineProject({
    components: {
      api: overrides.apiPattern ?? 'application/api/**',
      ui: overrides.uiPattern ?? 'application/ui/**',
    },
    rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui), c.arch.component(c.api).maxLinesPerFile(overrides.maxLoc ?? 300)],
  });
}

function context(overrides: { readonly excludes?: readonly string[]; readonly alignVersion?: string; readonly rules?: ReturnType<typeof ruleset> } = {}) {
  return buildScanHistoryContext({
    alignVersion: overrides.alignVersion ?? VERSION,
    ruleset: overrides.rules ?? ruleset(),
    excludes: overrides.excludes ?? ['dist/**'],
  });
}

function run(overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    verdict: 'green',
    gates: [],
    advisories: [],
    scannedAt: 0,
    ungroundedComponents: [],
    blindSpots: [],
    observedFiles: {
      source: new Set([toRepoRelativePath('application/api/a.ts'), toRepoRelativePath('application/ui/b.ts')]),
      manifest: new Set([toRepoRelativePath('package.json')]),
    },
    observedViolations: [
      { file: toRepoRelativePath('application/api/a.ts'), ruleId: firstRuleId(), contentFingerprint: toViolationId('cf-1') },
    ],
    componentMatchCounts: new Map([
      [toComponentName('api'), 1],
      [toComponentName('ui'), 1],
    ]),
    ...overrides,
  };
}

function firstRuleId() {
  const first = ruleset().rules[0];
  if (first === undefined) throw new Error('fixture ruleset has no rules');
  return toRuleId(first.id);
}

function recordFrom(overrides: Partial<CheckRun> = {}, ctx = context()): ScanObservationRecord {
  return buildScanObservation(run(overrides), ctx, 1_755_000_000_000);
}

describe('buildScanObservation projects a run into ADR 029 §2\'s record', () => {
  it('records both scan domains, the component counts, and the violations', () => {
    const record = recordFrom();
    expect(record.observed.source).toEqual(['application/api/a.ts', 'application/ui/b.ts']);
    expect(record.observed.manifest).toEqual(['package.json']);
    expect(record.components['api']?.matchCount).toBe(1);
    expect(record.violations).toHaveLength(1);
  });

  it('is order-stable, so an unchanged repository produces a byte-identical record', () => {
    // Load-bearing for §7.1's "write only when the observation changed": `observedFiles` is a Set
    // and `componentMatchCounts` is a Map, so without the sorts a re-scan could serialize the same
    // observation differently and rewrite the file on every check.
    const a = buildScanObservation(run(), context(), 1);
    const b = buildScanObservation(
      run({ observedFiles: { source: new Set([toRepoRelativePath('application/ui/b.ts'), toRepoRelativePath('application/api/a.ts')]), manifest: new Set([toRepoRelativePath('package.json')]) } }),
      context(),
      2,
    );
    expect(observationsDiffer(a, b)).toBe(false);
  });

  it('does not count a changed timestamp as a changed observation', () => {
    expect(observationsDiffer(recordFrom(), buildScanObservation(run(), context(), 9_999))).toBe(false);
  });

  it('DOES count a changed file set as a changed observation', () => {
    // Calibration for the test above: an `observedAt`-blind comparison that was blind to everything
    // would never write at all, and the mechanism would be permanently one scan behind.
    const moved = run({ observedFiles: { source: new Set([toRepoRelativePath('application/api/renamed.ts')]), manifest: new Set() } });
    expect(observationsDiffer(recordFrom(), buildScanObservation(moved, context(), 1))).toBe(true);
  });
});

describe('wasFileObserved — invalidated by version and by scan scope (ADR 029 §4)', () => {
  it('answers about a file the previous scan saw, and about one it did not', () => {
    const probe = createScanHistoryProbe(recordFrom(), context());
    expect(probe.wasFileObserved(toRepoRelativePath('application/api/a.ts'))).toEqual({ known: true, value: true });
    expect(probe.wasFileObserved(toRepoRelativePath('application/api/never.ts'))).toEqual({ known: true, value: false });
  });

  it('spans both domains — a manifest path is observed, not merely a source one', () => {
    const probe = createScanHistoryProbe(recordFrom(), context());
    expect(probe.wasFileObserved(toRepoRelativePath('package.json'))).toEqual({ known: true, value: true });
  });

  it('refuses to answer with no record at all', () => {
    expect(createScanHistoryProbe(undefined, context()).wasFileObserved(toRepoRelativePath('application/api/a.ts'))).toEqual({ known: false });
  });

  it('refuses to answer when the record was written by a different align', () => {
    const probe = createScanHistoryProbe(recordFrom(), context({ alignVersion: '0.3.0' }));
    expect(probe.wasFileObserved(toRepoRelativePath('application/api/a.ts'))).toEqual({ known: false });
  });

  it('refuses to answer when the scan scope changed', () => {
    // THE QUESTION THIS INVALIDATION EXISTS FOR. `wasFileObserved`'s `false` is an inference from
    // absence, and narrowing `excludes` makes a file absent for a reason that has nothing to do with
    // the repository — which is D009's direction and ADR 028's whole subject.
    const probe = createScanHistoryProbe(recordFrom(), context({ excludes: ['dist/**', 'vendor/**'] }));
    expect(probe.wasFileObserved(toRepoRelativePath('application/api/a.ts'))).toEqual({ known: false });
  });

  it('is not fooled by reordering excludes, which changes no file\'s fate', () => {
    const record = buildScanObservation(run(), context({ excludes: ['a/**', 'b/**'] }), 1);
    const probe = createScanHistoryProbe(record, context({ excludes: ['b/**', 'a/**'] }));
    expect(probe.wasFileObserved(toRepoRelativePath('application/api/a.ts'))).toEqual({ known: true, value: true });
  });
});

describe('wasViolationObservedAt — the question that closes the severity zeros', () => {
  const observed = { file: toRepoRelativePath('application/api/a.ts'), rule: firstRuleId(), fingerprint: toViolationId('cf-1') };

  it('remembers a violation at its exact path, rule and content', () => {
    const probe = createScanHistoryProbe(recordFrom(), context());
    expect(probe.wasViolationObservedAt(observed.file, observed.rule, observed.fingerprint)).toEqual({ known: true, value: true });
  });

  it('is path-specific — the same violation content at another path is not the same fact', () => {
    // The whole inference rests on this: "already violating HERE last scan" refutes a move ONTO
    // here. A content-only match would refute every move, everywhere, and disable ADR 006.
    const probe = createScanHistoryProbe(recordFrom(), context());
    expect(probe.wasViolationObservedAt(toRepoRelativePath('application/api/other.ts'), observed.rule, observed.fingerprint)).toEqual({
      known: true,
      value: false,
    });
  });

  it('refuses to answer once the cited rule has been redefined', () => {
    // `arch.metric`'s threshold moves from 300 to 50: same rule id, different meaning, so a violation
    // recorded under the old definition is not evidence about what the new one reports.
    const record = recordFrom();
    const probe = createScanHistoryProbe(record, context({ rules: ruleset({ maxLoc: 50 }) }));
    const metricRule = ruleset().rules[1];
    if (metricRule === undefined) throw new Error('fixture ruleset lost its metric rule');
    expect(probe.wasViolationObservedAt(observed.file, toRuleId(metricRule.id), observed.fingerprint)).toEqual({ known: false });
  });

  it('still answers about an UNCHANGED rule in the same edited ruleset', () => {
    // Per-question, per-RULE invalidation (ADR 029 §4) rather than one global staleness flag: editing
    // the metric rule must not discard what is known about the layer rule. A global flag would, and
    // its false discards are what teach a caller to stop trusting the signal.
    const probe = createScanHistoryProbe(recordFrom(), context({ rules: ruleset({ maxLoc: 50 }) }));
    expect(probe.wasViolationObservedAt(observed.file, observed.rule, observed.fingerprint)).toEqual({ known: true, value: true });
  });

  it('refuses to answer about a rule that no longer exists', () => {
    const probe = createScanHistoryProbe(recordFrom(), context());
    expect(probe.wasViolationObservedAt(observed.file, toRuleId('arch.deleted-rule'), observed.fingerprint)).toEqual({ known: false });
  });

  it('still answers after a scan-scope change — a reported violation stays reported', () => {
    // DELIBERATELY ASYMMETRIC with `wasFileObserved`, and asserted so the asymmetry is a decision
    // rather than an oversight. This question's `true` is a positive observation; narrowing or
    // widening the scan cannot make a violation align actually reported stop having been reported.
    // Gating it on scope identity would discard the sound answer in order to protect the unsound one.
    const probe = createScanHistoryProbe(recordFrom(), context({ excludes: ['everything/**'] }));
    expect(probe.wasViolationObservedAt(observed.file, observed.rule, observed.fingerprint)).toEqual({ known: true, value: true });
  });
});

describe('observedMatchCount — a count, and a prefix identity', () => {
  it('reports the previous scan\'s count, zeros included', () => {
    const record = buildScanObservation(run({ componentMatchCounts: new Map([[toComponentName('api'), 12], [toComponentName('ui'), 0]]) }), context(), 1);
    const probe = createScanHistoryProbe(record, context());
    expect(probe.observedMatchCount(toComponentName('api'))).toEqual({ known: true, value: 12 });
    // "matched 0 last scan and 0 now" is not a regression; "matched 12 and now 0" is. Only a count
    // can tell a consumer which of the two it is looking at.
    expect(probe.observedMatchCount(toComponentName('ui'))).toEqual({ known: true, value: 0 });
  });

  it('refuses to answer when the component\'s own selector changed', () => {
    const probe = createScanHistoryProbe(recordFrom(), context({ rules: ruleset({ uiPattern: 'src/ui/**' }) }));
    expect(probe.observedMatchCount(toComponentName('ui'))).toEqual({ known: false });
  });

  it('refuses to answer when an EARLIER component\'s selector changed — the shadowing gap', () => {
    // ADR 029 §4 says "c's selector changed", which is not sufficient: classification is
    // first-match-wins in declaration order, so widening `api` moves `ui`'s count without touching
    // `ui`'s definition. Hashing only a component's own selector would leave that stale count
    // admissible. This is the test the prefix identity exists for.
    const probe = createScanHistoryProbe(recordFrom(), context({ rules: ruleset({ apiPattern: 'application/**' }) }));
    expect(probe.observedMatchCount(toComponentName('ui'))).toEqual({ known: false });
  });

  it('a LATER component\'s selector change does not invalidate an earlier one', () => {
    // Calibration: without this, "invalidate on any registry change" would pass every test above
    // while being the coarse whole-ruleset hash ADR 029 §2 rejects.
    const probe = createScanHistoryProbe(recordFrom(), context({ rules: ruleset({ uiPattern: 'src/ui/**' }) }));
    expect(probe.observedMatchCount(toComponentName('api'))).toEqual({ known: true, value: 1 });
  });

  it('refuses to answer about a component the current ruleset no longer declares', () => {
    const probe = createScanHistoryProbe(recordFrom(), context());
    expect(probe.observedMatchCount(toComponentName('gone'))).toEqual({ known: false });
  });
});

describe('previousScopeIdentity — about the record, not about the repository', () => {
  it('answers even when the record came from a different align version', () => {
    const probe = createScanHistoryProbe(recordFrom(), context({ alignVersion: '0.9.9' }));
    expect(probe.previousScopeIdentity()).toEqual({ known: true, value: computeScopeIdentity({ excludes: ['dist/**'] }) });
  });

  it('is the only question with no invalidation beyond the record existing', () => {
    expect(createScanHistoryProbe(undefined, context()).previousScopeIdentity()).toEqual({ known: false });
  });
});

/**
 * ADR 029 §5, as far as a test of the PROBE can take it. The record is an unsigned, gitignored,
 * world-writable JSON file, so "what can a forged one do?" is a real question and not a thought
 * experiment.
 *
 * **Scope, stated so a green here is not read as more than it is.** These tests pin the *answers the
 * probe can be made to give*. They do not — and cannot — pin that a consumer turns those answers
 * into refusals rather than authorizations; that is a property of each consumer, and the place to
 * assert it is each consumer's own tests. Naming this block "a forged record can do nothing" would
 * be the same overclaim that let five documented interfaces drift under a one-interface test
 * (LEDGER D019).
 */
describe('a forged record cannot make the probe answer outside its own invalidation rules', () => {
  it('cannot make a probe answer `known: true` about a scope or version it did not run under', () => {
    // The two identity fields are the only thing standing between "a file appeared in a JSON blob"
    // and "align believes a scan observed it". Both are compared against values derived from the
    // LIVE config in this process, which a file on disk cannot influence.
    const forged: ScanObservationRecord = {
      ...recordFrom(),
      alignVersion: 'not-this-one',
      observed: { source: [toRepoRelativePath('anything.ts')], manifest: [] },
    };
    const probe = createScanHistoryProbe(forged, context());
    expect(probe.wasFileObserved(toRepoRelativePath('anything.ts'))).toEqual({ known: false });
  });

  it('every `known: true, value: true` it can produce is a positive fact, which §5 permits only as a refusal', () => {
    // Stated as an executable enumeration of the reachable answers, because the safety argument is
    // "there is no permission-shaped answer", and that is a claim about the whole surface rather
    // than about one call. A forged record's best case is claiming MORE was observed and MORE was
    // violating — both of which make a consumer decline a transfer, never make one.
    const forged: ScanObservationRecord = {
      ...recordFrom(),
      violations: [
        { file: toRepoRelativePath('bait.ts'), ruleId: firstRuleId(), contentFingerprint: toViolationId('cf-1') },
      ],
    };
    const probe = createScanHistoryProbe(forged, context());
    expect(probe.wasViolationObservedAt(toRepoRelativePath('bait.ts'), firstRuleId(), toViolationId('cf-1'))).toEqual({ known: true, value: true });
    // ...and the entry it displaced is now simply unknown-to-history, which is today's behaviour.
    expect(probe.wasViolationObservedAt(toRepoRelativePath('application/api/a.ts'), firstRuleId(), toViolationId('cf-1'))).toEqual({
      known: true,
      value: false,
    });
  });
});

describe('the identity helpers', () => {
  it('scope identity ignores order but not content', () => {
    expect(computeScopeIdentity({ excludes: ['a', 'b'] })).toBe(computeScopeIdentity({ excludes: ['b', 'a'] }));
    expect(computeScopeIdentity({ excludes: ['a'] })).not.toBe(computeScopeIdentity({ excludes: ['a', 'b'] }));
  });

  it('scope identity distinguishes a nested-checkout opt-in from none', () => {
    expect(computeScopeIdentity({ excludes: [] })).not.toBe(computeScopeIdentity({ excludes: [], includeNestedCheckouts: ['vendor/x'] }));
  });

  it('component identities are prefix-dependent in declaration order', () => {
    const before = computeComponentSelectorIdentities(ruleset().components);
    const afterEarlierChange = computeComponentSelectorIdentities(ruleset({ apiPattern: 'application/**' }).components);
    const afterLaterChange = computeComponentSelectorIdentities(ruleset({ uiPattern: 'src/ui/**' }).components);
    expect(afterEarlierChange.get(toComponentName('ui'))).not.toBe(before.get(toComponentName('ui')));
    expect(afterLaterChange.get(toComponentName('api'))).toBe(before.get(toComponentName('api')));
  });
});
