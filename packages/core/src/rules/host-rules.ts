import type { RuleIR } from '../types/ir.js';

/** Thrown when a `custom.host` rule names a host predicate that is not registered — the third
 * member of the vacuous-green family (`rules/component-refs.ts`, `components/registry.ts`'s
 * `validateClassifiedComponents`): `evaluateRule` returns zero violations for `custom.host`
 * (v1 has no host-defined rule execution mechanism, ADR 002's escape hatch being a schema slot,
 * not an exercised capability), so an unevaluatable rule would otherwise sit in the ruleset
 * reporting green — and even count toward `passCount` — while enforcing nothing. */
export class UnknownHostRuleError extends Error {
  constructor(
    public readonly ruleId: string,
    public readonly hostRuleName: string,
  ) {
    super(
      `Rule '${ruleId}' (custom.host) references host predicate '${hostRuleName}', which is not ` +
        `registered — v1 defines no host predicate mechanism, so this rule cannot be evaluated ` +
        `and would silently report green. Remove the rule (and re-run \`align build\` if it came ` +
        `from a doc), or keep the constraint as prose until host-defined rules ship.`,
    );
    this.name = 'UnknownHostRuleError';
  }
}

/**
 * Load-time validation, run in `GateOrchestrator.check`'s vacuous-green guard step: every
 * `custom.host` rule's `hostRuleName` must name a registered host predicate. v1 has no
 * registration surface (the DSL reserves the `custom` factory name without implementing it), so
 * the orchestrator passes an empty set and every `custom.host` rule fails hard — the set
 * parameter is the growth path for when a host predicate registry ships, not a v1 affordance.
 * Fail-fast on the first offender, same convention as the sibling validators.
 */
export function validateHostRules(rules: readonly RuleIR[], registeredHostPredicates: ReadonlySet<string>): void {
  for (const rule of rules) {
    if (rule.kind !== 'custom.host') continue;
    if (!registeredHostPredicates.has(rule.hostRuleName)) {
      throw new UnknownHostRuleError(rule.id, rule.hostRuleName);
    }
  }
}
