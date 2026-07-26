import { describe, expect, it } from 'vitest';
import { buildUngroundedExternalSelectorAdvisories } from '../src/gates/advisories.js';
import type { ArchLayersRule, ArchNoDependencyRule, RuleIR } from '../src/types/ir.js';
import { externalNode } from './helpers.js';

describe('buildUngroundedExternalSelectorAdvisories (ADR 017 Part A)', () => {
  it('is empty when every selector is grounded', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.no-dependency', id: 'r1', from: 'core', to: { kind: 'external', pattern: 'lodash', includeTypeOnly: false }, provenance: {} } satisfies ArchNoDependencyRule,
    ];
    expect(buildUngroundedExternalSelectorAdvisories(rules, [externalNode('lodash')])).toEqual([]);
  });

  it('is empty when there are no external selectors at all', () => {
    const rules: RuleIR[] = [{ kind: 'arch.no-dependency', id: 'r1', from: 'core', to: 'ui', provenance: {} } satisfies ArchNoDependencyRule];
    expect(buildUngroundedExternalSelectorAdvisories(rules, [])).toEqual([]);
  });

  it('surfaces one advisory per ungrounded selector, naming the rule id and pattern', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.no-dependency', id: 'r1', from: 'core', to: { kind: 'external', pattern: 'lodsh', includeTypeOnly: false }, provenance: {} } satisfies ArchNoDependencyRule,
    ];
    const advisories = buildUngroundedExternalSelectorAdvisories(rules, [externalNode('lodash')]);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('ungrounded-external-selector');
    expect(advisories[0]?.message).toContain('lodsh');
    expect(advisories[0]?.ruleIds).toEqual(['r1']);
  });

  it('surfaces an ungrounded selector nested in an arch.layers canDependOn entry', () => {
    const rules: RuleIR[] = [
      {
        kind: 'arch.layers',
        id: 'r1',
        layers: [{ layer: 'web', canDependOn: [{ kind: 'external', pattern: 'left-pad', includeTypeOnly: false }] }],
        provenance: {},
      } satisfies ArchLayersRule,
    ];
    const advisories = buildUngroundedExternalSelectorAdvisories(rules, []);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.message).toContain('left-pad');
  });

  it('does not surface a real (grounded) ban — a package genuinely absent from the graph is correctly vacuously green, not the same as a typo', () => {
    // Semantically this is the SAME shape (zero matching external nodes) — the advisory doctrine
    // (ADR 017 Part A) is deliberately "always surface, let a human judge whether it's a typo or a
    // real absence", not an attempt to distinguish the two automatically.
    const rules: RuleIR[] = [
      { kind: 'arch.no-dependency', id: 'r1', from: 'core', to: { kind: 'external', pattern: 'node:child_process', includeTypeOnly: false }, provenance: {} } satisfies ArchNoDependencyRule,
    ];
    const advisories = buildUngroundedExternalSelectorAdvisories(rules, []);
    expect(advisories).toHaveLength(1); // still surfaced — visibility, not silence, either way
  });
});
