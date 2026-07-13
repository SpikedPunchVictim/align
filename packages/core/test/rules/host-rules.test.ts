import { describe, expect, it } from 'vitest';
import {
  assertNoCustomHostRules,
  evaluateCustomHost,
  HostPredicateExecutionError,
  UnknownHostRuleError,
  UntrustedCustomHostRuleError,
  validateHostRules,
  type HostPredicate,
  type HostPredicateRegistry,
} from '../../src/rules/host-rules.js';
import type { CustomHostRule, RuleIR } from '../../src/types/ir.js';
import { edge, graph, node } from '../helpers.js';

const NONE: ReadonlySet<string> = new Set();

const ROUTE_THINNESS_RULE: CustomHostRule = {
  kind: 'custom.host',
  id: 'custom.host:route-thinness',
  hostRuleName: 'route-thinness',
  portable: false,
  provenance: {},
};

function registryOf(name: string, predicate: HostPredicate): HostPredicateRegistry {
  return new Map([[name, predicate]]);
}

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
      expect(e.message).toContain('hostRules');
      expect(e.message).toContain('remove the rule');
    }
  });

  it('does not throw when the predicate IS registered', () => {
    const rules: RuleIR[] = [
      { kind: 'custom.host', id: 'custom.host:route-thinness', hostRuleName: 'route-thinness', portable: false, provenance: {} } satisfies CustomHostRule,
    ];
    expect(() => validateHostRules(rules, new Set(['route-thinness']))).not.toThrow();
  });
});

describe('assertNoCustomHostRules (ADR 014, --untrusted pre-flight guard)', () => {
  it('does not throw when the ruleset has no custom.host rules', () => {
    const rules: RuleIR[] = [
      { kind: 'arch.no-dependency', id: 'r1', from: 'api', to: 'ui', provenance: {} },
      { kind: 'arch.no-cycles', id: 'r2', scope: 'repo', includeTypeOnly: false, provenance: {} },
    ];
    expect(() => assertNoCustomHostRules(rules)).not.toThrow();
  });

  it('throws UntrustedCustomHostRuleError naming every custom.host rule id, not just the first', () => {
    const rules: RuleIR[] = [
      { kind: 'custom.host', id: 'custom.host:a', hostRuleName: 'a', portable: false, provenance: {} },
      { kind: 'arch.no-cycles', id: 'r2', scope: 'repo', includeTypeOnly: false, provenance: {} },
      { kind: 'custom.host', id: 'custom.host:b', hostRuleName: 'b', portable: false, provenance: {} },
    ];
    try {
      assertNoCustomHostRules(rules);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UntrustedCustomHostRuleError);
      const e = err as UntrustedCustomHostRuleError;
      expect(e.ruleIds).toEqual(['custom.host:a', 'custom.host:b']);
      expect(e.message).toContain('custom.host:a');
      expect(e.message).toContain('custom.host:b');
      expect(e.message).toContain('--untrusted');
    }
  });

  it('is a distinct error type/message from UnknownHostRuleError — this is not a fixable registration bug', () => {
    const rules: RuleIR[] = [
      { kind: 'custom.host', id: 'custom.host:a', hostRuleName: 'a', portable: false, provenance: {} },
    ];
    try {
      assertNoCustomHostRules(rules);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).not.toBeInstanceOf(UnknownHostRuleError);
      expect((err as Error).message).not.toContain('typo');
      expect((err as Error).message).toContain('never imported');
    }
  });
});

describe('evaluateCustomHost', () => {
  it('runs the registered predicate and normalizes its HostViolation[] into full Violations', () => {
    const g = graph([node('api/routes.ts', 'api', 50)], []);
    const predicate: HostPredicate = (ctx) => {
      expect(ctx.files).toEqual(['api/routes.ts']);
      expect(ctx.componentOf('api/routes.ts')).toBe('api');
      return [{ file: 'api/routes.ts', range: { startLine: 3, endLine: 3 }, snippet: 'export function handler() {}', message: 'route handler is not thin' }];
    };
    const violations = evaluateCustomHost(ROUTE_THINNESS_RULE, g, registryOf('route-thinness', predicate));
    expect(violations).toHaveLength(1);
    const v = violations[0];
    expect(v?.kind).toBe('custom');
    if (v?.kind === 'custom') {
      expect(v.file).toBe('api/routes.ts');
      expect(v.range).toEqual({ startLine: 3, endLine: 3 });
      expect(v.snippet).toBe('export function handler() {}');
      expect(v.detail).toBe('route handler is not thin');
      expect(v.hostRuleName).toBe('route-thinness');
      expect(v.ruleId).toBe('custom.host:route-thinness');
      expect(v.category).toBe('architecture');
      expect(v.fixHint).toEqual({ code: 'manual-review' });
    }
  });

  it('defaults range to line 1 and snippet to the scanned node snippet when a HostViolation omits them', () => {
    const g = graph([node('api/routes.ts', 'api', 50, "// first line of routes.ts")], []);
    const predicate: HostPredicate = () => [{ file: 'api/routes.ts', message: 'file-level finding' }];
    const violations = evaluateCustomHost(ROUTE_THINNESS_RULE, g, registryOf('route-thinness', predicate));
    expect(violations[0]?.range).toEqual({ startLine: 1, endLine: 1 });
    expect(violations[0]?.snippet).toBe('// first line of routes.ts');
  });

  it('hoists the rule\'s .because() onto every violation, like every other evaluator', () => {
    const g = graph([node('api/routes.ts', 'api')], []);
    const rule: CustomHostRule = { ...ROUTE_THINNESS_RULE, provenance: { because: 'Route handlers stay thin.' } };
    const predicate: HostPredicate = () => [{ file: 'api/routes.ts', message: 'too fat' }];
    const violations = evaluateCustomHost(rule, g, registryOf('route-thinness', predicate));
    expect(violations[0]?.because).toBe('Route handlers stay thin.');
  });

  it('produces a stable fingerprint for the same finding, unaffected by unrelated graph state', () => {
    const predicate: HostPredicate = () => [{ file: 'api/routes.ts', range: { startLine: 3, endLine: 3 }, message: 'too fat' }];
    const g1 = graph([node('api/routes.ts', 'api')], []);
    const g2 = graph([node('api/routes.ts', 'api'), node('ui/other.ts', 'ui')], [edge('ui/other.ts', 'api/routes.ts')]);
    const id1 = evaluateCustomHost(ROUTE_THINNESS_RULE, g1, registryOf('route-thinness', predicate))[0]?.id;
    const id2 = evaluateCustomHost(ROUTE_THINNESS_RULE, g2, registryOf('route-thinness', predicate))[0]?.id;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });

  it('returns zero violations when the predicate finds nothing (a clean run is not an error)', () => {
    const g = graph([node('api/routes.ts', 'api')], []);
    const predicate: HostPredicate = () => [];
    expect(evaluateCustomHost(ROUTE_THINNESS_RULE, g, registryOf('route-thinness', predicate))).toHaveLength(0);
  });

  it('throws UnknownHostRuleError (defense in depth) when the predicate is not in the registry, even without validateHostRules having run first', () => {
    const g = graph([], []);
    expect(() => evaluateCustomHost(ROUTE_THINNESS_RULE, g, new Map())).toThrow(UnknownHostRuleError);
  });

  it('wraps a thrown predicate in HostPredicateExecutionError — never a silent pass, never an unattributed crash', () => {
    const g = graph([node('api/routes.ts', 'api')], []);
    const predicate: HostPredicate = () => {
      throw new Error('boom: predicate has a bug');
    };
    try {
      evaluateCustomHost(ROUTE_THINNESS_RULE, g, registryOf('route-thinness', predicate));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HostPredicateExecutionError);
      const e = err as HostPredicateExecutionError;
      expect(e.ruleId).toBe('custom.host:route-thinness');
      expect(e.hostRuleName).toBe('route-thinness');
      expect(e.predicateError).toBeInstanceOf(Error);
      expect(e.message).toContain('custom.host:route-thinness');
      expect(e.message).toContain("'route-thinness'");
      expect(e.message).toContain('boom: predicate has a bug');
      expect(e.message).toContain('pure function');
    }
  });

  it('wraps a non-Error thrown value (e.g. a string throw) without losing the detail', () => {
    const g = graph([node('api/routes.ts', 'api')], []);
    const predicate: HostPredicate = () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'not an Error instance';
    };
    try {
      evaluateCustomHost(ROUTE_THINNESS_RULE, g, registryOf('route-thinness', predicate));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HostPredicateExecutionError);
      expect((err as HostPredicateExecutionError).message).toContain('not an Error instance');
    }
  });
});
