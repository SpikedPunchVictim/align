import { globMatch } from '../components/glob.js';
import type { ExternalPackageNode } from '../types/graph.js';
import type { ArchLayersRule, ArchNoDependencyRule, ExternalSelector, RuleIR } from '../types/ir.js';
import { toRuleId, type RuleId } from '../types/branded.js';

/**
 * External-selector pattern matching (ADR 017 Part A, pinned in `docs/ir-schema.md`): glob over
 * the normalized external id. A `node:`-prefixed pattern (`'node:*'`, `'node:fs'`) only matches a
 * builtin (`ExternalPackageNode.isBuiltin`) — the prefix is stripped before glob-matching the
 * remainder against `packageName`. An unprefixed pattern (`'fs'`, `'lodash'`, `'@scope/*'`) matches
 * by `packageName` alone, regardless of builtin-ness — this is deliberate (ADR 017: `external('fs')`
 * must also match the Node builtin, whose `packageName` is `'fs'`, same as a hypothetical npm
 * package literally named `fs` would be — an accepted, documented simplification, not a bug).
 */
export function externalSelectorMatchesNode(pattern: string, node: ExternalPackageNode): boolean {
  const requiresBuiltin = pattern.startsWith('node:');
  const namePattern = requiresBuiltin ? pattern.slice('node:'.length) : pattern;
  if (requiresBuiltin && !node.isBuiltin) return false;
  return globMatch(namePattern, node.packageName);
}

/** Finds the first external node (if any) an `ExternalSelector` matches — used by the
 * ungrounded-selector advisory below; evaluators scan `graph.externalEdges` directly instead
 * (this is a "does at least one grounding node exist" check, not a match-and-evaluate step). */
export function anyExternalNodeMatches(pattern: string, nodes: readonly ExternalPackageNode[]): boolean {
  return nodes.some((n) => externalSelectorMatchesNode(pattern, n));
}

/** Every `ExternalSelector` a rule embeds, alongside the rule's own id — the external-selector
 * sibling of `rules/component-refs.ts`'s `componentRefsOf` generator, same exhaustive-switch
 * discipline. Only `arch.no-dependency` (`to`, when not a `ComponentRef`) and `arch.layers` (each
 * layer's `canDependOn` entries, when not a `ComponentRef`) can carry one — every other rule kind
 * yields nothing. */
export function* externalSelectorsOf(rule: RuleIR): Generator<{ readonly ruleId: RuleId; readonly selector: ExternalSelector }> {
  switch (rule.kind) {
    case 'arch.no-dependency': {
      const noDep = rule as ArchNoDependencyRule;
      if (typeof noDep.to !== 'string') yield { ruleId: toRuleId(noDep.id), selector: noDep.to };
      return;
    }
    case 'arch.layers': {
      const layers = rule as ArchLayersRule;
      for (const layerDef of layers.layers) {
        for (const entry of layerDef.canDependOn) {
          if (typeof entry !== 'string') yield { ruleId: toRuleId(layers.id), selector: entry };
        }
      }
      return;
    }
    case 'arch.no-cycles':
    case 'custom.host':
    case 'arch.metric':
    case 'security.manifest.source-hygiene':
    case 'security.manifest.new-dependency':
      return;
    default: {
      const exhaustive: never = rule;
      throw new Error(`unhandled rule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface UngroundedExternalSelector {
  readonly ruleId: RuleId;
  readonly pattern: string;
}

/**
 * The `ungroundedComponents` precedent (ADR 008's 2026-07-13 amendment), applied to external
 * selectors (ADR 017 Part A): a selector matching zero nodes in `graph.externalNodes` skips ADR
 * 008 reference-validity (a ban on an absent package is *correctly* vacuously green — the package
 * genuinely isn't imported) but must not be silently, permanently green — a typo
 * (`external('lodsh')`) is surfaced here instead. Callers (currently `gates/advisories.ts`) turn
 * this into an `Advisory`, mirroring "surfaced as an advisory" from the ADR's own wording rather
 * than a new dedicated `CheckRun` field.
 */
export function findUngroundedExternalSelectors(
  rules: readonly RuleIR[],
  externalNodes: readonly ExternalPackageNode[],
): UngroundedExternalSelector[] {
  const out: UngroundedExternalSelector[] = [];
  for (const rule of rules) {
    for (const { ruleId, selector } of externalSelectorsOf(rule)) {
      if (!anyExternalNodeMatches(selector.pattern, externalNodes)) {
        out.push({ ruleId, pattern: selector.pattern });
      }
    }
  }
  return out;
}
