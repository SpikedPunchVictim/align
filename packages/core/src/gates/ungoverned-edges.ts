import { toComponentName, type ComponentName } from '../types/branded.js';
import type { DependencyGraph } from '../types/graph.js';
import type { RulesetIR } from '../types/ir.js';

/**
 * ADR 019 Mode 2 (ACCEPTED, v1 = import-graph-only), docs/proposals/reconciled-build-order.md #3
 * -- "the real silence-fixer." Enumerates component-to-component import edges NOT covered by any
 * existing arch.no-dependency / arch.layers rule (edges-minus-ruleset, pure graph computation) --
 * boundaries a human hasn't decided on yet. Not a new rule kind and not enforcement: a suggestion
 * surface only (align doctor wires this in). No git-history/co-change pass -- that was measured
 * and cut from ADR 019 v1; every input here is already computed by align's scanner.
 */
export interface UngovernedEdgeGap {
  readonly from: ComponentName;
  readonly to: ComponentName;
  /** Import-site count for this specific from->to pair (ADR 019's "edge-weight"). */
  readonly edgeWeight: number;
  /** Distinct components (repo-wide, not just this pair) with at least one edge into `to` (ADR
   * 019's "fan-in" -- "distinct importers"). A property of `to`, not of the pair. */
  readonly fanIn: number;
  /** True when a `to -> from` edge also exists in the graph. ADR 019's Precision-critical section:
   * the graph can flag this as cycle-risk, but never decide direction/intent -- surfaced as a flag
   * for the human, not auto-escalated to a stronger finding. */
  readonly bidirectional: boolean;
}

interface AggregatedEdge {
  readonly from: ComponentName;
  readonly to: ComponentName;
  edgeWeight: number;
}

const PAIR_SEP = '::';

/** Directed pair key -- (from, to) order matters (A->B and B->A are distinct edges). */
function directedPairKey(from: ComponentName, to: ComponentName): string {
  return `${from}${PAIR_SEP}${to}`;
}

/** Unordered pair key -- used only for rule-coverage lookups, where the ADR treats a rule naming
 * {A,B} in either direction as covering the pair. */
function unorderedPairKey(a: ComponentName, b: ComponentName): string {
  return a < b ? `${a}${PAIR_SEP}${b}` : `${b}${PAIR_SEP}${a}`;
}

interface RulesetCoverageIndex {
  readonly noDependencyPairs: ReadonlySet<string>;
  readonly layerComponents: ReadonlySet<ComponentName>;
}

/** Indexes the two rule kinds ADR 019 recognizes as coverage -- arch.no-cycles, arch.metric,
 * custom.host, and security.manifest.* say nothing about a directed component-pair boundary, so
 * they don't participate here (align check already enforces whatever they do constrain). */
function indexRulesetCoverage(ruleset: RulesetIR): RulesetCoverageIndex {
  const noDependencyPairs = new Set<string>();
  const layerComponents = new Set<ComponentName>();
  for (const rule of ruleset.rules) {
    if (rule.kind === 'arch.no-dependency') {
      // `RuleIR`'s ComponentRef fields are plain `string` at the zod-schema level (ir.ts's
      // `componentRef = componentName`, itself a regex-validated `z.string()`, not the branded
      // `ComponentName`) -- `toComponentName` is the established cast at this trusted boundary
      // (same convention as `components/registry.ts`'s `findUngroundedComponents`), since these
      // refs are already validated against the components registry by the time a `RulesetIR`
      // reaches here (`rules/component-refs.ts`'s `validateRuleComponentRefs`).
      noDependencyPairs.add(unorderedPairKey(toComponentName(rule.from), toComponentName(rule.to)));
    } else if (rule.kind === 'arch.layers') {
      for (const layerDef of rule.layers) layerComponents.add(toComponentName(layerDef.layer));
    }
  }
  return { noDependencyPairs, layerComponents };
}

/**
 * ADR 019's governed computation, literally: a directed edge from->to is GOVERNED if any existing
 * rule constrains that pair -- an arch.no-dependency naming the pair in EITHER direction, or an
 * arch.layers rule whose `layer` field is either endpoint. A layers rule fully enumerates its
 * layer's allowed outbound set (canOnlyDependOn), so it settles every edge touching that component
 * on either side -- deliberately direction-symmetric, matching the ADR's stated computation rather
 * than re-deriving enforcement semantics a second time (that's align check's job; this is a
 * coverage question, not a compliance one).
 */
function isGoverned(from: ComponentName, to: ComponentName, coverage: RulesetCoverageIndex): boolean {
  if (coverage.noDependencyPairs.has(unorderedPairKey(from, to))) return true;
  return coverage.layerComponents.has(from) || coverage.layerComponents.has(to);
}

/**
 * Computes every ungoverned component-to-component import edge, ranked by edge-weight (desc), then
 * fan-in of the target (desc), then name (for deterministic output when both tie).
 *
 * `compositionRoots` -- explicit, human-declared component names (ADR 019's Precision-critical
 * section explicitly rejects a fan-out/glob-breadth heuristic here: it can't tell a legitimate
 * catch-all from a god-component, and would suppress exactly the finding that matters most) -- are
 * excluded as an edge SOURCE only: a catch-all component's outbound fan-out is expected and never
 * reported as a gap, regardless of governed status. A component named as a compositionRoot can
 * still surface as a GAP's *target* if something ungoverned depends on it.
 *
 * Pure over the graph + ruleset -- no I/O, no git-history mining (co-change is cut from ADR 019 v1).
 */
export function computeUngovernedEdgeGaps(
  graph: DependencyGraph,
  ruleset: RulesetIR,
  compositionRoots: ReadonlySet<ComponentName> = new Set(),
): UngovernedEdgeGap[] {
  // Restricting to components the ruleset actually declares is what excludes unmapped/unknown
  // files without core needing any notion of align-plugin-typescript's UNMAPPED_COMPONENT
  // sentinel (core never imports a plugin -- ARCHITECTURE.md section 5): a component nobody
  // declared can be neither governed nor ungoverned, there's nothing to decide about it.
  const declaredComponents = new Set(Object.keys(ruleset.components));
  const fileToComponent = new Map<string, ComponentName>();
  for (const n of graph.nodes) {
    if (declaredComponents.has(n.component)) fileToComponent.set(n.file, n.component);
  }

  const aggregated = new Map<string, AggregatedEdge>();
  for (const e of graph.edges) {
    const from = fileToComponent.get(e.from);
    const to = fileToComponent.get(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = directedPairKey(from, to);
    const existing = aggregated.get(key);
    if (existing === undefined) aggregated.set(key, { from, to, edgeWeight: 1 });
    else existing.edgeWeight += 1;
  }

  // Component-level fan-in (ADR 019: "distinct importers"): distinct SOURCE components with at
  // least one edge into a given target, repo-wide -- not scoped to ungoverned pairs, since fan-in
  // describes the whole graph's shape, not just the gap list.
  const fanInByTarget = new Map<ComponentName, Set<ComponentName>>();
  for (const { from, to } of aggregated.values()) {
    const importers = fanInByTarget.get(to);
    if (importers === undefined) fanInByTarget.set(to, new Set([from]));
    else importers.add(from);
  }

  const coverage = indexRulesetCoverage(ruleset);

  const gaps: UngovernedEdgeGap[] = [];
  for (const { from, to, edgeWeight } of aggregated.values()) {
    if (compositionRoots.has(from)) continue; // explicit, human-declared exclusion -- no heuristic
    if (isGoverned(from, to, coverage)) continue;

    gaps.push({
      from,
      to,
      edgeWeight,
      fanIn: fanInByTarget.get(to)?.size ?? 0,
      bidirectional: aggregated.has(directedPairKey(to, from)),
    });
  }

  gaps.sort(
    (a, b) => b.edgeWeight - a.edgeWeight || b.fanIn - a.fanIn || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  return gaps;
}
