/**
 * Rule-kind reference (Stage 5, IMPLEMENTATION_PLAN.md "Elevated first items"): the *list* of
 * kinds is walked live off `ruleIRSchema` (`@align/core`'s zod discriminated union) — never
 * hand-typed — so a new rule kind added to the IR shows up here automatically and a forgotten
 * description fails fast (`describeRuleKinds`), the same discipline `dsl/verb-manifest.ts`
 * applies to the DSL verb surface. `test/skill-completeness.test.ts` additionally asserts every
 * live kind's text actually appears in the rendered skill markdown — the "adding a rule kind
 * without skill coverage must fail CI" requirement.
 */
import { ruleIRSchema } from '@align/core';
import type { z } from 'zod';

/** Walks the live `ruleIRSchema` discriminated union and returns its member `kind` literals in
 * declaration order — the "generated from the live schema/IR registry" source of truth. */
export function getRuleKinds(): readonly string[] {
  const union = ruleIRSchema as unknown as { options: readonly z.ZodObject<{ kind: z.ZodLiteral<string> }>[] };
  return union.options.map((option) => option.shape.kind.value);
}

// Hand-written one-liners, keyed by the live kind string above — RULE_KIND_DESCRIPTIONS is
// prose, but its *coverage* is enforced: `describeRuleKinds` throws for any live kind missing an
// entry here, and the skill-completeness test throws for any entry whose kind no longer exists.
const RULE_KIND_DESCRIPTIONS: Record<string, string> = {
  'arch.no-dependency': 'One component must not import from another. Authored via `arch.layer(x).cannotDependOn(y)` or `arch.component(x).isIsolated()`.',
  'arch.no-cycles': 'No import cycle within a scope (component or the whole repo). Authored via `arch.noCycles(scope?, { includeTypeOnly? })`. Violations carry per-edge chain detail, not just file names.',
  'arch.layers': 'A component may depend only on an explicit allowlist of other components. Authored via `arch.layer(x).canOnlyDependOn(...)`.',
  'arch.metric': 'A component-scoped numeric limit — today only `metric: "loc"` (max lines per file) is promoted; fan-in/fan-out/instability remain reserved pending evidence. Authored via `arch.component(x).maxLinesPerFile(max)`.',
  'custom.host': "An escape hatch referencing a `HostPredicate` your `align.config.ts` registers by name in its `hostRules` export (`Record<string, HostPredicate>`). REGISTRATION IS REQUIRED: `custom.host('foo')` in the ruleset with no `hostRules.foo` predicate hard-errors the gate at check time (it never silently reports green) — register the predicate, fix the name, or remove the rule. Authored via `custom.host(hostRuleName)`.",
  'security.manifest.source-hygiene': 'Flags any dependency specifier resolving to a git/http(s)/file/link source instead of the registry or `workspace:`. Authored via `security.manifest.sourceHygiene()`. Repo-wide — no component scoping.',
  'security.manifest.new-dependency': 'Fingerprints every current runtime/dev dependency at baseline time; a genuinely new dependency added afterward shows red until accepted. Authored via `security.manifest.newDependencyGate()`. Repo-wide — no component scoping.',
};

export interface RuleKindEntry {
  readonly kind: string;
  readonly description: string;
}

/** Fails fast if a live kind has no description — the mechanism that keeps this file from
 * silently drifting behind a new rule kind. */
export function describeRuleKinds(): readonly RuleKindEntry[] {
  const kinds = getRuleKinds();
  return kinds.map((kind) => {
    const description = RULE_KIND_DESCRIPTIONS[kind];
    if (description === undefined) {
      throw new Error(
        `skill/rule-kinds.ts: live rule kind '${kind}' (from ruleIRSchema) has no entry in ` +
          `RULE_KIND_DESCRIPTIONS. Add one so \`align skill\` cannot silently omit a rule kind the ` +
          `installed binary actually supports.`,
      );
    }
    return { kind, description };
  });
}

export function renderRuleKindsSection(): string {
  const lines = describeRuleKinds().map((entry) => `- \`${entry.kind}\` — ${entry.description}`);
  return lines.join('\n');
}
