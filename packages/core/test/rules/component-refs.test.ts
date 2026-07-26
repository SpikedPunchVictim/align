import { describe, expect, it } from 'vitest';
import { UnknownComponentRefError, validateRuleComponentRefs } from '../../src/rules/component-refs.js';
import type {
  ArchLayersRule,
  ArchMetricRule,
  ArchNoCyclesRule,
  ArchNoDependencyRule,
  ComponentDefinitionIR,
  CustomHostRule,
  RuleIR,
} from '../../src/types/ir.js';
import type { ComponentName } from '../../src/types/branded.js';

function components(...names: string[]): Readonly<Record<ComponentName, ComponentDefinitionIR>> {
  const out: Record<string, ComponentDefinitionIR> = {};
  for (const name of names) {
    out[name] = { name, selector: { kind: 'glob', patterns: [`${name}/**`] }, empty: 'fail' };
  }
  return out as Readonly<Record<ComponentName, ComponentDefinitionIR>>;
}

describe('validateRuleComponentRefs', () => {
  it('does not throw when every ComponentRef resolves to a known component', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.no-dependency', id: 'r1', from: 'api', to: 'ui', provenance: {} } satisfies ArchNoDependencyRule,
      { kind: 'arch.no-cycles', id: 'r2', scope: 'api', includeTypeOnly: false, provenance: {} } satisfies ArchNoCyclesRule,
      { kind: 'arch.no-cycles', id: 'r3', scope: 'repo', includeTypeOnly: false, provenance: {} } satisfies ArchNoCyclesRule,
      {
        kind: 'arch.layers',
        id: 'r4',
        layers: [{ layer: 'api', canDependOn: ['ui'] }],
        provenance: {},
      } satisfies ArchLayersRule,
      { kind: 'custom.host', id: 'r5', hostRuleName: 'whatever', portable: false, provenance: {} } satisfies CustomHostRule,
      { kind: 'arch.metric', id: 'r6', target: 'api', metric: 'loc', max: 800, provenance: {} } satisfies ArchMetricRule,
    ];
    expect(() => validateRuleComponentRefs(rules, components('api', 'ui'))).not.toThrow();
  });

  it('throws UnknownComponentRefError naming the rule id and the missing component for arch.no-dependency `from`', () => {
    const rules: RuleIR[] = [{ kind: 'arch.no-dependency', id: 'ghost-rule', from: 'ghost', to: 'ui', provenance: {} } satisfies ArchNoDependencyRule];
    expect(() => validateRuleComponentRefs(rules, components('ui'))).toThrow(UnknownComponentRefError);
    try {
      validateRuleComponentRefs(rules, components('ui'));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownComponentRefError);
      const e = err as UnknownComponentRefError;
      expect(e.ruleId).toBe('ghost-rule');
      expect(e.componentName).toBe('ghost');
      expect(e.message).toContain('ghost-rule');
      expect(e.message).toContain('ghost');
      expect(e.message).toContain('align build');
    }
  });

  it('throws for arch.no-dependency `to`', () => {
    const rules: RuleIR[] = [{ kind: 'arch.no-dependency', id: 'r', from: 'api', to: 'ghost', provenance: {} } satisfies ArchNoDependencyRule];
    expect(() => validateRuleComponentRefs(rules, components('api'))).toThrow(UnknownComponentRefError);
  });

  it('throws for arch.no-cycles `scope` when not `repo`', () => {
    const rules: RuleIR[] = [{ kind: 'arch.no-cycles', id: 'r', scope: 'ghost', includeTypeOnly: false, provenance: {} } satisfies ArchNoCyclesRule];
    expect(() => validateRuleComponentRefs(rules, components('api'))).toThrow(UnknownComponentRefError);
  });

  it('does not throw for arch.no-cycles `scope: "repo"` regardless of the registry', () => {
    const rules: RuleIR[] = [{ kind: 'arch.no-cycles', id: 'r', scope: 'repo', includeTypeOnly: false, provenance: {} } satisfies ArchNoCyclesRule];
    expect(() => validateRuleComponentRefs(rules, components())).not.toThrow();
  });

  it('throws for arch.layers `layer`', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.layers', id: 'r', layers: [{ layer: 'ghost', canDependOn: [] }], provenance: {} } satisfies ArchLayersRule,
    ];
    expect(() => validateRuleComponentRefs(rules, components('api'))).toThrow(UnknownComponentRefError);
  });

  it('throws for arch.layers `canDependOn` entries', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.layers', id: 'r', layers: [{ layer: 'api', canDependOn: ['ghost'] }], provenance: {} } satisfies ArchLayersRule,
    ];
    expect(() => validateRuleComponentRefs(rules, components('api'))).toThrow(UnknownComponentRefError);
  });

  it('custom.host rules carry no ComponentRef and never throw', () => {
    const rules: RuleIR[] = [{ kind: 'custom.host', id: 'r', hostRuleName: 'x', portable: false, provenance: {} } satisfies CustomHostRule];
    expect(() => validateRuleComponentRefs(rules, components())).not.toThrow();
  });

  describe('external selectors (ADR 017 Part A) are not ComponentRefs', () => {
    it('an arch.no-dependency `to` that is an external selector never throws, even against an empty registry', () => {
      const rules: RuleIR[] = [
        {
          kind: 'arch.no-dependency',
          id: 'r',
          from: 'api',
          to: { kind: 'external', pattern: 'node:child_process', includeTypeOnly: false },
          provenance: {},
        } satisfies ArchNoDependencyRule,
      ];
      expect(() => validateRuleComponentRefs(rules, components('api'))).not.toThrow();
    });

    it('still throws when `from` is an unknown component, even though `to` is external', () => {
      const rules: RuleIR[] = [
        {
          kind: 'arch.no-dependency',
          id: 'r',
          from: 'ghost',
          to: { kind: 'external', pattern: 'node:*', includeTypeOnly: false },
          provenance: {},
        } satisfies ArchNoDependencyRule,
      ];
      expect(() => validateRuleComponentRefs(rules, components('api'))).toThrow(UnknownComponentRefError);
    });

    it('an arch.layers canDependOn entry that is an external selector never throws', () => {
      const rules: RuleIR[] = [
        {
          kind: 'arch.layers',
          id: 'r',
          layers: [{ layer: 'api', canDependOn: ['ui', { kind: 'external', pattern: 'lodash', includeTypeOnly: false }] }],
          provenance: {},
        } satisfies ArchLayersRule,
      ];
      expect(() => validateRuleComponentRefs(rules, components('api', 'ui'))).not.toThrow();
    });

    it('still throws when a canDependOn entry is an unknown component alongside a valid external selector', () => {
      const rules: RuleIR[] = [
        {
          kind: 'arch.layers',
          id: 'r',
          layers: [{ layer: 'api', canDependOn: ['ghost', { kind: 'external', pattern: 'lodash', includeTypeOnly: false }] }],
          provenance: {},
        } satisfies ArchLayersRule,
      ];
      expect(() => validateRuleComponentRefs(rules, components('api'))).toThrow(UnknownComponentRefError);
    });
  });

  it('throws UnknownComponentRefError naming the rule id and the missing component for arch.metric `target`', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.metric', id: 'ghost-metric', target: 'ghost', metric: 'loc', max: 800, provenance: {} } satisfies ArchMetricRule,
    ];
    expect(() => validateRuleComponentRefs(rules, components('api'))).toThrow(UnknownComponentRefError);
    try {
      validateRuleComponentRefs(rules, components('api'));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownComponentRefError);
      const e = err as UnknownComponentRefError;
      expect(e.ruleId).toBe('ghost-metric');
      expect(e.componentName).toBe('ghost');
    }
  });
});
