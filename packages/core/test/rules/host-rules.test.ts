import { describe, expect, it } from 'vitest';
import { UnknownHostRuleError, validateHostRules } from '../../src/rules/host-rules.js';
import type { CustomHostRule, RuleIR } from '../../src/types/ir.js';

const NONE: ReadonlySet<string> = new Set();

describe('validateHostRules', () => {
  it('ignores non-custom.host rules entirely', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.no-dependency', id: 'r1', from: 'api', to: 'ui', provenance: {} },
      { kind: 'arch.no-cycles', id: 'r2', scope: 'repo', includeTypeOnly: false, provenance: {} },
    ];
    expect(() => validateHostRules(rules, NONE)).not.toThrow();
  });

  it('throws UnknownHostRuleError for a custom.host rule whose predicate is not registered, naming rule id and predicate', () => {
    const rules: RuleIR[] = [
      { kind: 'custom.host', id: 'custom.host:route-thinness', hostRuleName: 'route-thinness', portable: false, provenance: {} } satisfies CustomHostRule,
    ];
    try {
      validateHostRules(rules, NONE);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownHostRuleError);
      const e = err as UnknownHostRuleError;
      expect(e.ruleId).toBe('custom.host:route-thinness');
      expect(e.hostRuleName).toBe('route-thinness');
      expect(e.message).toContain('custom.host:route-thinness');
      expect(e.message).toContain("'route-thinness'");
      expect(e.message).toContain('Remove the rule');
    }
  });

  it('does not throw when the predicate IS registered (growth path — v1 has no registration surface, the orchestrator always passes an empty set)', () => {
    const rules: RuleIR[] = [
      { kind: 'custom.host', id: 'custom.host:route-thinness', hostRuleName: 'route-thinness', portable: false, provenance: {} } satisfies CustomHostRule,
    ];
    expect(() => validateHostRules(rules, new Set(['route-thinness']))).not.toThrow();
  });
});
