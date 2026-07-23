import { describe, expect, it } from 'vitest';
import { anyExternalNodeMatches, externalSelectorMatchesNode, externalSelectorsOf, findUngroundedExternalSelectors } from '../../src/rules/external-match.js';
import type { ArchLayersRule, ArchNoDependencyRule, ArchNoCyclesRule, RuleIR } from '../../src/types/ir.js';
import { externalNode } from '../helpers.js';

describe('externalSelectorMatchesNode', () => {
  it('matches a Node builtin via a node:-prefixed pattern', () => {
    expect(externalSelectorMatchesNode('node:fs', externalNode('fs', true))).toBe(true);
  });

  it('matches a Node builtin via node:* wildcard', () => {
    expect(externalSelectorMatchesNode('node:*', externalNode('fs', true))).toBe(true);
    expect(externalSelectorMatchesNode('node:*', externalNode('child_process', true))).toBe(true);
  });

  it('matches a Node builtin via a bare (unprefixed) pattern too', () => {
    expect(externalSelectorMatchesNode('fs', externalNode('fs', true))).toBe(true);
  });

  it('a node:-prefixed pattern does not match a non-builtin package of the same name', () => {
    expect(externalSelectorMatchesNode('node:fs', externalNode('fs', false))).toBe(false);
  });

  it('matches an npm package by exact name', () => {
    expect(externalSelectorMatchesNode('lodash', externalNode('lodash', false))).toBe(true);
  });

  it('matches a scoped package via a scope wildcard', () => {
    expect(externalSelectorMatchesNode('@scope/*', externalNode('@scope/pkg', false))).toBe(true);
    expect(externalSelectorMatchesNode('@scope/*', externalNode('@other/pkg', false))).toBe(false);
  });

  it('does not match an unrelated package name', () => {
    expect(externalSelectorMatchesNode('lodash', externalNode('react', false))).toBe(false);
  });

  it('node:* does not match a non-builtin package', () => {
    expect(externalSelectorMatchesNode('node:*', externalNode('lodash', false))).toBe(false);
  });
});

describe('externalSelectorsOf', () => {
  it('yields the external selector on arch.no-dependency when `to` is external', () => {
    const rule: ArchNoDependencyRule = {
      kind: 'arch.no-dependency',
      id: 'r1',
      from: 'core',
      to: { kind: 'external', pattern: 'node:*', includeTypeOnly: false },
      provenance: {},
    };
    const found = [...externalSelectorsOf(rule)];
    expect(found).toHaveLength(1);
    expect(found[0]?.selector.pattern).toBe('node:*');
    expect(found[0]?.ruleId).toBe('r1');
  });

  it('yields nothing when arch.no-dependency `to` is a plain component', () => {
    const rule: ArchNoDependencyRule = { kind: 'arch.no-dependency', id: 'r1', from: 'core', to: 'ui', provenance: {} };
    expect([...externalSelectorsOf(rule)]).toHaveLength(0);
  });

  it('yields every external selector across every layer of arch.layers', () => {
    const rule: ArchLayersRule = {
      kind: 'arch.layers',
      id: 'r1',
      layers: [
        {
          layer: 'core',
          canDependOn: ['ui', { kind: 'external', pattern: 'lodash', includeTypeOnly: false }],
        },
      ],
      provenance: {},
    };
    const found = [...externalSelectorsOf(rule)];
    expect(found).toHaveLength(1);
    expect(found[0]?.selector.pattern).toBe('lodash');
  });

  it('yields nothing for rule kinds with no dependency-target shape', () => {
    const rule: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'r1', scope: 'repo', includeTypeOnly: false, provenance: {} };
    expect([...externalSelectorsOf(rule)]).toHaveLength(0);
  });
});

describe('anyExternalNodeMatches', () => {
  it('true when at least one node matches', () => {
    expect(anyExternalNodeMatches('lodash', [externalNode('react'), externalNode('lodash')])).toBe(true);
  });

  it('false when no node matches (ungrounded)', () => {
    expect(anyExternalNodeMatches('lodsh', [externalNode('react'), externalNode('lodash')])).toBe(false);
  });
});

describe('findUngroundedExternalSelectors', () => {
  it('surfaces a selector matching zero external nodes', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.no-dependency', id: 'r1', from: 'core', to: { kind: 'external', pattern: 'lodsh', includeTypeOnly: false }, provenance: {} },
    ];
    const result = findUngroundedExternalSelectors(rules, [externalNode('lodash')]);
    expect(result).toEqual([{ ruleId: 'r1', pattern: 'lodsh' }]);
  });

  it('does not surface a grounded selector', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.no-dependency', id: 'r1', from: 'core', to: { kind: 'external', pattern: 'lodash', includeTypeOnly: false }, provenance: {} },
    ];
    expect(findUngroundedExternalSelectors(rules, [externalNode('lodash')])).toEqual([]);
  });

  it('is empty when no rule embeds an external selector', () => {
    const rules: RuleIR[] = [{ kind: 'arch.no-dependency', id: 'r1', from: 'core', to: 'ui', provenance: {} }];
    expect(findUngroundedExternalSelectors(rules, [])).toEqual([]);
  });
});
