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
 */
export function groundFragment(
  fragment: RuleFragment,
  section: string,
  sourceFile: RepoRelativePath,
  sourceLineRange: SourceRange,
  sourceQuote: string,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
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
      // Never groundable in v1: no host predicate registry exists, and `evaluateRule` returns
      // zero violations for the kind — writing this rule would make the dry-run report "adds 0
      // new violations" vacuously and `align check` count it as passing while enforcing nothing
      // (the same silent-rule-drop class as an unknown ComponentRef; see
      // rules/host-rules.ts, which closes the check-time half). Flagged, never silently written
      // (ADR 011).
      return flag(
        section,
        sourceFile,
        sourceLineRange,
        sourceQuote,
        `host predicate '${fragment.hostRuleName}' is not registered — v1 has no host-defined ` +
          `rule mechanism, so a custom.host rule cannot be evaluated and would silently report ` +
          `green; keep this constraint as prose until host predicates ship`,
        'unregistered-host-rule',
      );
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
