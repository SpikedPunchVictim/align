import { describe, expect, it } from 'vitest';
import { computeImpactDelta } from '../../src/build/impact.js';
import { diffGeneratedRules } from '../../src/build/diff.js';
import { evaluateRule } from '../../src/rules/evaluators.js';
import type { ArchNoDependencyRule, RuleIR } from '../../src/types/ir.js';
import type { Violation } from '../../src/types/violation.js';
import type { BaselineEntry } from '../../src/baseline/store.js';
import { toComponentName, toRuleId, toRepoRelativePath, toViolationId } from '../../src/types/branded.js';
import { edge, graph, node } from '../helpers.js';

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

/**
 * "Impact delta only re-evaluates structural changes" (task requirement, live-session finding):
 * a `.because()`-only edit to a rule must never appear as an "adds N new violations" surprise.
 * This holds today because `Violation.id` (the fingerprint `computeImpactDelta` sets-compares on)
 * is derived from `rule.id` + structural edge/node data only, never from `rule.provenance` — this
 * end-to-end test exercises the real `evaluateRule` pipeline (not a hand-fabricated Violation) to
 * prove it, using exactly `diffGeneratedRules`'s "zero structural changes" classification from the
 * live-session scenario (`build/diff.test.ts`) as the input.
 */
describe('impact delta is unaffected by provenance-only rule changes (end-to-end)', () => {
  it('re-evaluating the same rule with only a new .because() produces zero addedNew / zero maskedBaselined', () => {
    const g = graph([node('api/a.ts', 'api'), node('ui/b.ts', 'ui')], [edge('api/a.ts', 'ui/b.ts', { specifier: '../ui/b', line: 5 })]);

    const before: ArchNoDependencyRule = { kind: 'arch.no-dependency', id: 'r1', from: 'api', to: 'ui', provenance: {} };
    const after: ArchNoDependencyRule = { ...before, provenance: { because: 'Newly attached rationale, not a structural change.' } };

    // Confirms the fixture actually reproduces the live-session scenario this invariant is
    // named after — if this assertion ever fails, the invariant test below is testing the wrong
    // thing.
    const diff = diffGeneratedRules([before as RuleIR], [after as RuleIR]);
    expect(diff.changed).toHaveLength(0);
    expect(diff.provenanceOnlyChanged).toHaveLength(1);

    const currentViolations = evaluateRule(before, g, {});
    const proposedViolations = evaluateRule(after, g, {});
    expect(currentViolations).toHaveLength(1);
    expect(proposedViolations).toHaveLength(1);
    expect(currentViolations[0]?.id).toBe(proposedViolations[0]?.id); // stable fingerprint

    const delta = computeImpactDelta(currentViolations, proposedViolations, []);
    expect(delta.addedNew).toHaveLength(0);
    expect(delta.maskedBaselined).toHaveLength(0);
  });
});
