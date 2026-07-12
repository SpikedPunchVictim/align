import { toComponentName, toRuleId, type ComponentName, type RepoRelativePath } from '../types/branded.js';
import type { ComponentDefinitionIR, RuleIR } from '../types/ir.js';
import type { SourceRange } from '../types/violation.js';
import { ruleIRSchema } from '../types/ir.js';
import type { RuleFragment } from './schema.js';
import { buildProvenance } from './provenance.js';
import type { FlaggedProposal } from './types.js';

/** Strips markdown emphasis (`` `x` ``, `"x"`, `'x'`) a fragment/bullet author might wrap a
 * component name in, then trims. Grounding itself is always exact-match after this normalization
 * — deliberately no fuzzy/substring matching in align's own code (ADR 011: align supplies
 * validation and truth; fuzzy judgment belongs to the connected client agent in the MCP path, per
 * the "ADR ambiguities" resolution documented in the Stage 3 report). */
function normalizeRef(raw: string): string {
  return raw.trim().replace(/^[`"']+|[`"']+$/g, '');
}

/** Grounds one selector token against the components registry (ADR 003/011) — exact match only,
 * case-sensitive first then case-insensitive fallback (docs commonly capitalize a component name
 * mid-sentence). Returns `undefined` if nothing matches; the caller flags the proposal rather than
 * guessing. */
export function groundComponentRef(
  raw: string,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
): ComponentName | undefined {
  const normalized = normalizeRef(raw);
  if (normalized in components) return toComponentName(normalized);
  const lower = normalized.toLowerCase();
  for (const name of Object.keys(components)) {
    if (name.toLowerCase() === lower) return toComponentName(name);
  }
  return undefined;
}

export type GroundResult = { readonly ok: true; readonly rule: RuleIR } | { readonly ok: false; readonly flagged: FlaggedProposal };

function flag(
  section: string,
  sourceFile: RepoRelativePath,
  sourceLineRange: SourceRange,
  sourceQuote: string,
  detail: string,
  reason: FlaggedProposal['reason'] = 'ungroundable-selector',
): GroundResult {
  return { ok: false, flagged: { section, sourceFile, sourceLineRange, sourceQuote, reason, detail } };
}

/**
 * Grounds a `RuleFragment` (tier-1 JSON, tier-2 bullet grammar output, or an MCP-submitted
 * proposal) against the components registry and builds the final `RuleIR` node, complete with a
 * content-addressed `id` and full `RuleProvenance` (ADR 011). Pure — no I/O, no LLM. Every
 * selector must resolve to an existing component; the first unresolvable one flags the whole
 * fragment rather than partially grounding it.
 *
 * `registeredHostPredicates` defaults to empty — a doc/MCP-proposed `custom.host` fragment is only
 * ever groundable when its `hostRuleName` names a predicate the caller's `align.config.ts` already
 * registers (docs/proposals/rule-expansion-evaluation.md §B.0); callers thread this from the same
 * `hostRules` export the CLI composition root extracts for `GateOrchestrator` (`config.ts`), so
 * "groundable" and "checkable" always agree.
 */
export function groundFragment(
  fragment: RuleFragment,
  section: string,
  sourceFile: RepoRelativePath,
  sourceLineRange: SourceRange,
  sourceQuote: string,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
  registeredHostPredicates: ReadonlySet<string> = new Set(),
): GroundResult {
  const provenance = buildProvenance(sourceFile, sourceLineRange, sourceQuote, fragment.because);

  switch (fragment.kind) {
    case 'arch.no-dependency': {
      const from = groundComponentRef(fragment.from, components);
      if (from === undefined) return flag(section, sourceFile, sourceLineRange, sourceQuote, `unknown component '${fragment.from}'`);
      const to = groundComponentRef(fragment.to, components);
      if (to === undefined) return flag(section, sourceFile, sourceLineRange, sourceQuote, `unknown component '${fragment.to}'`);
      const rule = ruleIRSchema.parse({
        kind: 'arch.no-dependency',
        id: toRuleId(`arch.no-dependency:${from}->${to}`),
        from,
        to,
        provenance,
      });
      return { ok: true, rule };
    }
    case 'arch.no-cycles': {
      let scope: 'repo' | ComponentName = 'repo';
      if (fragment.scope !== undefined && fragment.scope !== 'repo') {
        const grounded = groundComponentRef(fragment.scope, components);
        if (grounded === undefined) return flag(section, sourceFile, sourceLineRange, sourceQuote, `unknown component '${fragment.scope}'`);
        scope = grounded;
      }
      const rule = ruleIRSchema.parse({
        kind: 'arch.no-cycles',
        id: toRuleId(`arch.no-cycles:${scope}`),
        scope,
        includeTypeOnly: fragment.includeTypeOnly ?? false,
        provenance,
      });
      return { ok: true, rule };
    }
    case 'arch.layers': {
      const entry = fragment.layers[0];
      if (entry === undefined) return flag(section, sourceFile, sourceLineRange, sourceQuote, 'empty layers array');
      const layer = groundComponentRef(entry.layer, components);
      if (layer === undefined) return flag(section, sourceFile, sourceLineRange, sourceQuote, `unknown component '${entry.layer}'`);
      const canDependOn: ComponentName[] = [];
      for (const ref of entry.canDependOn) {
        const grounded = groundComponentRef(ref, components);
        if (grounded === undefined) return flag(section, sourceFile, sourceLineRange, sourceQuote, `unknown component '${ref}'`);
        canDependOn.push(grounded);
      }
      const rule = ruleIRSchema.parse({
        kind: 'arch.layers',
        id: toRuleId(`arch.layers:${layer}`),
        layers: [{ layer, canDependOn }],
        provenance,
      });
      return { ok: true, rule };
    }
    case 'custom.host': {
      // Groundable only when the name is actually registered (`hostRules` in align.config.ts) —
      // otherwise this would make the dry-run report "adds 0 new violations" vacuously and
      // `align check` would hard-error on it anyway (rules/host-rules.ts's `validateHostRules`
      // closes the check-time half; this closes the propose/build-time half). Flagged, never
      // silently written (ADR 011).
      if (!registeredHostPredicates.has(fragment.hostRuleName)) {
        return flag(
          section,
          sourceFile,
          sourceLineRange,
          sourceQuote,
          `host predicate '${fragment.hostRuleName}' is not registered in align.config.ts's ` +
            `'hostRules' export, so a custom.host rule naming it cannot be evaluated and would ` +
            `silently report green; register the predicate first, or keep this constraint as ` +
            `prose until it does`,
          'unregistered-host-rule',
        );
      }
      const rule = ruleIRSchema.parse({
        kind: 'custom.host',
        id: toRuleId(`custom.host:${fragment.hostRuleName}`),
        hostRuleName: fragment.hostRuleName,
        portable: false,
        provenance,
      });
      return { ok: true, rule };
    }
    case 'arch.metric': {
      const target = groundComponentRef(fragment.target, components);
      if (target === undefined) return flag(section, sourceFile, sourceLineRange, sourceQuote, `unknown component '${fragment.target}'`);
      const rule = ruleIRSchema.parse({
        kind: 'arch.metric',
        id: toRuleId(`arch.metric:${fragment.metric}:${target}`),
        target,
        metric: fragment.metric,
        max: fragment.max,
        provenance,
      });
      return { ok: true, rule };
    }
    default: {
      const exhaustive: never = fragment;
      throw new Error(`unhandled fragment kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
