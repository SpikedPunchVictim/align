import type { ComponentName } from '../types/branded.js';
import type { ComponentDefinitionIR, RuleIR } from '../types/ir.js';

/** Thrown when a rule (hand-authored in `align.config.ts` or machine-written in
 * `.align/generated-rules.json`) references a component name absent from the current components
 * registry — a config-load-time hard error (ADR 003's empty-selector-fails-by-default doctrine
 * extended to the symmetric case: a *ComponentRef* naming a component that no longer exists).
 * Without this check, `evaluateRule` (`rules/evaluators.ts`) simply never matches a component
 * name absent from the graph, so the rule silently evaluates to zero violations — a false-green,
 * severity-zero bug class (ARCHITECTURE.md's stated invariant), most commonly triggered by a
 * component rename/removal in `align.config.ts` leaving a stale reference behind in generated
 * or hand-authored rules. */
export class UnknownComponentRefError extends Error {
  constructor(
    // Matches `RuleIR['id']`'s actual (unbranded) type — same convention as
    // `GeneratedRuleCollisionError` in `build/merge.ts`.
    public readonly ruleId: string,
    public readonly componentName: string,
  ) {
    super(
      `Rule '${ruleId}' references unknown component '${componentName}', which is not defined in ` +
        `the components registry. Likely cause: the component was renamed or removed since this rule ` +
        `was written — if this is a generated rule, re-run \`align build\` to refresh ` +
        `.align/generated-rules.json; if hand-authored, update align.config.ts.`,
    );
    this.name = 'UnknownComponentRefError';
  }
}

/** Every `ComponentRef` a rule embeds, in a fixed, deterministic order — one generator per IR
 * kind, exhaustively switched (a new `RuleIR` kind missing a case here is a compile error, same
 * discipline as `evaluateRule`'s dispatcher). `custom.host` carries no `ComponentRef` — it
 * references a host predicate by name (`hostRuleName`), validated by `rules/host-rules.ts`'s
 * `validateHostRules`, not by this component-reference guard. */
function* componentRefsOf(rule: RuleIR): Generator<string> {
  switch (rule.kind) {
    case 'arch.no-dependency':
      yield rule.from;
      // ADR 017 Part A: `to` widens to `ComponentRef | ExternalSelector`. An external selector is
      // not a `ComponentRef` at all — it's a glob pattern matched against `graph.externalEdges`
      // (`rules/external-match.ts`), never validated against the components registry (there is no
      // "unknown external package" error class the way there is an unknown component — a pattern
      // matching zero external nodes is instead surfaced as an ungrounded-selector advisory, the
      // `findUngroundedExternalSelectors` sibling of this file's own guard).
      if (typeof rule.to === 'string') yield rule.to;
      return;
    case 'arch.no-cycles':
      if (rule.scope !== 'repo') yield rule.scope;
      return;
    case 'arch.layers':
      for (const layerDef of rule.layers) {
        yield layerDef.layer;
        // Same external-selector carve-out as `arch.no-dependency.to` above.
        for (const entry of layerDef.canDependOn) if (typeof entry === 'string') yield entry;
      }
      return;
    case 'arch.metric':
      yield rule.target;
      return;
    case 'custom.host':
      return;
    // `security.manifest.*` (ADR 013) carries no `ComponentRef` — the manifest scan domain has no
    // notion of align's file-classified components (same no-op shape as `custom.host`, which
    // references a host predicate by name instead).
    case 'security.manifest.source-hygiene':
    case 'security.manifest.new-dependency':
      return;
    default: {
      const exhaustive: never = rule;
      throw new Error(`unhandled rule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Load-time validation (companion to `components/registry.ts`'s `validateComponents`, which
 * checks components against files; this checks rules against components): every `ComponentRef`
 * embedded in every rule — merged generated + hand-authored alike, since both share one
 * `RuleIR[]` by the time this runs (`build/merge.ts`) — must name a component present in the
 * registry. Throws `UnknownComponentRefError` on the first offender found (fail-fast, same
 * convention as `validateComponents`), not a collected list — one bad ref is enough to halt.
 */
export function validateRuleComponentRefs(
  rules: readonly RuleIR[],
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
): void {
  for (const rule of rules) {
    for (const ref of componentRefsOf(rule)) {
      if (!(ref in components)) {
        throw new UnknownComponentRefError(rule.id, ref);
      }
    }
  }
}
