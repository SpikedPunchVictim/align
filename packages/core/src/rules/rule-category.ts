import type { Category } from '../types/violation.js';
import type { RuleIR } from '../types/ir.js';

/**
 * Which gate a `RuleIR` belongs to (ADR 013): the orchestrator uses this to partition
 * `RulesetIR.rules` before evaluation, since `arch.*`/`custom.host` rules evaluate against the
 * TypeScript-scanned `DependencyGraph` (`rules/evaluators.ts`'s `evaluateRule`) while
 * `security.manifest.*` rules evaluate against a `ManifestInventory`
 * (`rules/manifest-evaluators.ts`'s `evaluateManifestRule`) — two disjoint scan domains that must
 * never be evaluated through each other's dispatcher. Exhaustive switch, same discipline as
 * `evaluateRule`/`componentRefsOf` — a new `RuleIR` kind without a case here is a compile error.
 */
export function ruleCategoryOf(rule: RuleIR): Category {
  switch (rule.kind) {
    case 'arch.no-dependency':
    case 'arch.no-cycles':
    case 'arch.layers':
    case 'arch.metric':
    case 'custom.host':
      return 'architecture';
    case 'security.manifest.source-hygiene':
    case 'security.manifest.new-dependency':
      return 'security';
    default: {
      const exhaustive: never = rule;
      throw new Error(`unhandled rule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
