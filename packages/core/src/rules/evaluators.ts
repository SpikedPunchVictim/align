import type { ComponentName, RepoRelativePath } from '../types/branded.js';
import { toRuleId } from '../types/branded.js';
import type { ArchLayersRule, ArchMetricRule, ArchNoCyclesRule, ArchNoDependencyRule, ComponentDefinitionIR, ExternalSelector, RuleIR } from '../types/ir.js';
import type { DependencyGraph, DependencyGraphEdge, EdgeKind } from '../types/graph.js';
import type { CycleEdge, Violation } from '../types/violation.js';
import { computeFingerprint } from '../baseline/fingerprint.js';
import { extractCycleChainNodes, tarjanScc } from './tarjan.js';
import { evaluateCustomHost, type HostPredicateRegistry } from './host-rules.js';
import { externalSelectorMatchesNode } from './external-match.js';

/** No predicates registered — the default for callers that don't pass a registry (most tests, and
 * any evaluation path that only exercises portable `arch.*` kinds). A `custom.host` rule
 * evaluated against this empty registry throws `UnknownHostRuleError`, same as an unregistered
 * name against a real registry — there is no silent-zero-violations path (ADR 008 amendment). */
const NO_HOST_PREDICATES: HostPredicateRegistry = new Map();

/**
 * Pure function: (rule, graph, components) -> violations. No I/O, no mutation, fully testable
 * with plain data (CODING_BEST_PRACTICES.md §14). One evaluator per RuleIR kind; `evaluateRule`
 * dispatches by `kind` through an exhaustive switch so a new IR kind missing an evaluator is a
 * compile error, not a silent no-op.
 */
export type RuleEvaluator<TRule extends RuleIR = RuleIR> = (
  rule: TRule,
  graph: DependencyGraph,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
) => readonly Violation[];

// `exactOptionalPropertyTypes` (CODING_BEST_PRACTICES.md §9) forbids assigning `undefined` to an
// optional field explicitly — spread this in rather than writing `because: rule.provenance.because`.
// Exported: `rules/manifest-evaluators.ts`'s manifest-domain evaluators share this exact helper
// rather than duplicating it (CODING_BEST_PRACTICES.md's rule-of-three) — both evaluator families
// build the same `ViolationBase` shape from the same `RuleProvenance`.
export function becauseField(because: string | undefined): { readonly because: string } | Record<string, never> {
  return because === undefined ? {} : { because };
}

export const evaluateNoDependency: RuleEvaluator<ArchNoDependencyRule> = (rule, graph) => {
  // ADR 017 Part A: `to` widened to `ComponentRef | ExternalSelector`. An external target is
  // matched against `graph.externalEdges` only — `graph.nodes`/`graph.edges` (the internal-only
  // arm below) are untouched by construction, so a rule with a plain component `to` is byte-
  // identical to pre-widening behavior (the `evaluators.test.ts` "external-package retention does
  // not change arch.* evaluator semantics" regression suite pins this).
  if (typeof rule.to !== 'string') {
    return evaluateNoDependencyExternal(rule, rule.to, graph);
  }

  const nodeByFile = new Map(graph.nodes.map((n) => [n.file, n]));
  const violations: Violation[] = [];
  for (const edge of graph.edges) {
    const fromNode = nodeByFile.get(edge.from);
    const toNode = nodeByFile.get(edge.to);
    if (fromNode === undefined || toNode === undefined) continue;
    if (fromNode.component !== rule.from || toNode.component !== rule.to) continue;

    const id = computeFingerprint(['no-dependency', rule.id, edge.from, edge.to, edge.specifier]);
    violations.push({
      id,
      ruleId: toRuleId(rule.id),
      category: 'architecture',
      severity: 'error',
      file: edge.from,
      range: { startLine: edge.line, endLine: edge.line },
      snippet: edge.snippet,
      fixHint: { code: 'remove-import', file: edge.from, line: edge.line },
      ...becauseField(rule.provenance.because),
      kind: 'no-dependency',
      fromFile: edge.from,
      toFile: edge.to,
      fromComponent: fromNode.component,
      toComponent: toNode.component,
      specifier: edge.specifier,
      line: edge.line,
    });
  }
  return violations;
};

/** The external-edge arm of `evaluateNoDependency` (ADR 017 Part A). `includeTypeOnly` (default
 * `false`, mirrors `arch.no-cycles`) gates whether a `type-only` external edge counts at all —
 * everywhere else edge `kind` is ignored (unchanged from the internal arm above). */
function evaluateNoDependencyExternal(rule: ArchNoDependencyRule, selector: ExternalSelector, graph: DependencyGraph): Violation[] {
  const nodeByFile = new Map(graph.nodes.map((n) => [n.file, n]));
  const externalNodeById = new Map(graph.externalNodes.map((n) => [n.id, n]));
  const violations: Violation[] = [];

  for (const edge of graph.externalEdges) {
    const fromNode = nodeByFile.get(edge.from);
    if (fromNode === undefined || fromNode.component !== rule.from) continue;
    if (edge.kind === 'type-only' && !selector.includeTypeOnly) continue;
    const targetNode = externalNodeById.get(edge.to);
    if (targetNode === undefined) continue;
    if (!externalSelectorMatchesNode(selector.pattern, targetNode)) continue;

    const id = computeFingerprint(['no-dependency-external', rule.id, edge.from, edge.to, edge.specifier]);
    violations.push({
      id,
      ruleId: toRuleId(rule.id),
      category: 'architecture',
      severity: 'error',
      file: edge.from,
      range: { startLine: edge.line, endLine: edge.line },
      snippet: edge.snippet,
      fixHint: { code: 'remove-import', file: edge.from, line: edge.line },
      ...becauseField(rule.provenance.because),
      kind: 'no-dependency-external',
      fromFile: edge.from,
      fromComponent: fromNode.component,
      toExternal: edge.to,
      externalPackageName: targetNode.packageName,
      specifier: edge.specifier,
      line: edge.line,
    });
  }
  return violations;
}

const RUNTIME_KINDS: readonly EdgeKind[] = ['import', 'reexport', 'dynamic'];
const ALL_KINDS: readonly EdgeKind[] = ['import', 'reexport', 'dynamic', 'type-only'];

export const evaluateNoCycles: RuleEvaluator<ArchNoCyclesRule> = (rule, graph) => {
  const nodeByFile = new Map(graph.nodes.map((n) => [n.file, n]));
  const inScope = (file: RepoRelativePath): boolean =>
    rule.scope === 'repo' ? true : nodeByFile.get(file)?.component === rule.scope;
  const allowedKinds = new Set(rule.includeTypeOnly ? ALL_KINDS : RUNTIME_KINDS);

  const adjacency = new Map<RepoRelativePath, RepoRelativePath[]>();
  for (const node of graph.nodes) if (inScope(node.file)) adjacency.set(node.file, []);

  const edgeByPair = new Map<string, DependencyGraphEdge>();
  for (const edge of graph.edges) {
    if (!allowedKinds.has(edge.kind)) continue;
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
    // First edge wins for a given (from, to) pair when the chain is rendered — enough to name a
    // concrete importable specifier/line without enumerating every parallel edge.
    const key = `${edge.from} ${edge.to}`;
    if (!edgeByPair.has(key)) edgeByPair.set(key, edge);
  }

  const sccs = tarjanScc(adjacency);
  const violations: Violation[] = [];
  for (const scc of sccs) {
    const isSelfLoop = scc.length === 1 && (scc[0] === undefined ? false : (adjacency.get(scc[0]) ?? []).includes(scc[0]));
    if (scc.length <= 1 && !isSelfLoop) continue;

    const chainNodes = extractCycleChainNodes(scc, adjacency);
    const chain: CycleEdge[] = [];
    for (let i = 0; i < chainNodes.length - 1; i += 1) {
      const from = chainNodes[i];
      const to = chainNodes[i + 1];
      if (from === undefined || to === undefined) continue;
      const edge = edgeByPair.get(`${from} ${to}`);
      if (edge === undefined) continue;
      chain.push({ from, to, specifier: edge.specifier, line: edge.line });
    }
    if (chain.length === 0) continue;

    const breakHop = chain[chain.length - 1];
    if (breakHop === undefined) continue;
    const breakEdgeRaw = edgeByPair.get(`${breakHop.from} ${breakHop.to}`);
    if (breakEdgeRaw === undefined) continue;

    const id = computeFingerprint(['no-cycles', rule.id, ...chain.map((e) => `${e.from}>${e.to}:${e.specifier}`)]);
    const firstFile = chainNodes[0];
    if (firstFile === undefined) continue;

    violations.push({
      id,
      ruleId: toRuleId(rule.id),
      category: 'architecture',
      severity: 'error',
      file: firstFile,
      range: { startLine: breakHop.line, endLine: breakHop.line },
      snippet: breakEdgeRaw.snippet,
      fixHint: { code: 'break-cycle-edge', suggestedEdge: breakHop },
      ...becauseField(rule.provenance.because),
      kind: 'no-cycles',
      chain,
      suggestedBreakEdge: breakHop,
    });
  }
  return violations;
};

export const evaluateLayers: RuleEvaluator<ArchLayersRule> = (rule, graph) => {
  const nodeByFile = new Map(graph.nodes.map((n) => [n.file, n]));
  const externalNodeById = new Map(graph.externalNodes.map((n) => [n.id, n]));
  const violations: Violation[] = [];

  for (const layerDef of rule.layers) {
    const allowedComponents = new Set<ComponentName>(
      layerDef.canDependOn.filter((entry): entry is ComponentName => typeof entry === 'string'),
    );
    const externalSelectors = layerDef.canDependOn.filter((entry): entry is ExternalSelector => typeof entry !== 'string');

    for (const edge of graph.edges) {
      const fromNode = nodeByFile.get(edge.from);
      const toNode = nodeByFile.get(edge.to);
      if (fromNode === undefined || toNode === undefined) continue;
      if (fromNode.component !== layerDef.layer) continue;
      if (toNode.component === fromNode.component) continue; // intra-layer is always fine
      if (allowedComponents.has(toNode.component)) continue;

      const id = computeFingerprint(['layers', rule.id, edge.from, edge.to, edge.specifier]);
      violations.push({
        id,
        ruleId: toRuleId(rule.id),
        category: 'architecture',
        severity: 'error',
        file: edge.from,
        range: { startLine: edge.line, endLine: edge.line },
        snippet: edge.snippet,
        fixHint: { code: 'remove-import', file: edge.from, line: edge.line },
        ...becauseField(rule.provenance.because),
        kind: 'layers',
        fromLayer: fromNode.component,
        toLayer: toNode.component,
        fromFile: edge.from,
        toFile: edge.to,
        specifier: edge.specifier,
        line: edge.line,
      });
    }

    // ADR 017 Part A back-compat invariant: external edges are evaluated for this layer ONLY if
    // it names >=1 external selector. Zero external selectors -> `continue` before touching
    // `graph.externalEdges` at all, so a components-only allow-list is byte-identical to
    // pre-widening behavior (the same-count regression test in evaluators.test.ts pins this).
    if (externalSelectors.length === 0) continue;

    for (const edge of graph.externalEdges) {
      const fromNode = nodeByFile.get(edge.from);
      if (fromNode === undefined || fromNode.component !== layerDef.layer) continue;

      // `includeTypeOnly` (mirrors arch.no-cycles): a type-only edge is entirely out of scope for
      // any selector that doesn't opt in — not "unmatched, hence forbidden", but excluded from
      // this rule's consideration altogether, same as no-cycles excludes type-only edges from its
      // scan by default.
      const applicableSelectors = edge.kind === 'type-only' ? externalSelectors.filter((s) => s.includeTypeOnly) : externalSelectors;
      if (edge.kind === 'type-only' && applicableSelectors.length === 0) continue;

      const targetNode = externalNodeById.get(edge.to);
      if (targetNode === undefined) continue;
      if (applicableSelectors.some((sel) => externalSelectorMatchesNode(sel.pattern, targetNode))) continue;

      const id = computeFingerprint(['layers-external', rule.id, edge.from, edge.to, edge.specifier]);
      violations.push({
        id,
        ruleId: toRuleId(rule.id),
        category: 'architecture',
        severity: 'error',
        file: edge.from,
        range: { startLine: edge.line, endLine: edge.line },
        snippet: edge.snippet,
        fixHint: { code: 'remove-import', file: edge.from, line: edge.line },
        ...becauseField(rule.provenance.because),
        kind: 'layers-external',
        fromLayer: fromNode.component,
        fromFile: edge.from,
        toExternal: edge.to,
        externalPackageName: targetNode.packageName,
        specifier: edge.specifier,
        line: edge.line,
      });
    }
  }
  return violations;
};

/**
 * `arch.metric` (max-LOC only, promoted 2026-07-12 on kluster ruleset evidence —
 * IMPLEMENTATION_PLAN.md's Promotion log: two 2,100+-line files were structurally invisible to
 * every dependency/cycle rule). One violation per file classified to `rule.target` whose `loc`
 * exceeds `rule.max` — `loc` is already on every `DependencyGraphNode` (no new scanning).
 */
export const evaluateMetric: RuleEvaluator<ArchMetricRule> = (rule, graph) => {
  const violations: Violation[] = [];
  for (const node of graph.nodes) {
    if (node.component !== rule.target) continue;
    if (node.loc <= rule.max) continue;

    const id = computeFingerprint(['metric', rule.id, node.file]);
    violations.push({
      id,
      ruleId: toRuleId(rule.id),
      category: 'architecture',
      severity: 'error',
      file: node.file,
      range: { startLine: 1, endLine: 1 },
      snippet: node.snippet,
      fixHint: { code: 'split-file', file: node.file },
      ...becauseField(rule.provenance.because),
      kind: 'metric',
      metric: rule.metric,
      component: node.component,
      value: node.loc,
      threshold: rule.max,
    });
  }
  return violations;
};

/**
 * Exhaustive dispatcher: a new `RuleIR` discriminant without a case here is a compile error
 * (never-check, CODING_BEST_PRACTICES.md §17.2), not a silent no-op.
 *
 * `hostPredicates` defaults to the empty registry — every `arch.*` evaluator ignores it entirely
 * (they never took it before registration existed); only `custom.host` reads it. A predicate that
 * throws propagates out of this function uncaught (`HostPredicateExecutionError`) exactly like a
 * malformed rule would — the orchestrator's evaluation-loop guard is what turns that into gate
 * `error` (`orchestrator.ts`), not this function, which stays a pure dispatcher.
 *
 * `security.manifest.*` kinds (ADR 013) return `[]` here, deliberately: this dispatcher only ever
 * receives a `DependencyGraph` (TS-source scan output), and manifest rules evaluate against a
 * disjoint scan domain (`ManifestInventory`) that this function never has access to. They are real
 * `RuleIR` members (needed so the DSL/tier-2/build pipeline can author and round-trip them), but
 * their actual evaluation always goes through `evaluateManifestRule`
 * (`rules/manifest-evaluators.ts`) against real manifest data — `GateOrchestrator`'s `security` gate
 * calls it directly and never routes these kinds through this function (`ruleCategoryOf` partitions
 * `RulesetIR.rules` before either dispatcher runs, `rules/rule-category.ts`). Returning `[]` here
 * (rather than throwing) keeps `align build`/`align explain`'s generic graph-based preview paths
 * working without a manifest scan available to them — see ADR 013's follow-up ladder for the known
 * gap this leaves (their impact-delta preview under-reports manifest-rule violations; `align check`
 * remains authoritative).
 */
export function evaluateRule(
  rule: RuleIR,
  graph: DependencyGraph,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
  hostPredicates: HostPredicateRegistry = NO_HOST_PREDICATES,
): readonly Violation[] {
  switch (rule.kind) {
    case 'arch.no-dependency':
      return evaluateNoDependency(rule, graph, components);
    case 'arch.no-cycles':
      return evaluateNoCycles(rule, graph, components);
    case 'arch.layers':
      return evaluateLayers(rule, graph, components);
    case 'arch.metric':
      return evaluateMetric(rule, graph, components);
    case 'custom.host':
      return evaluateCustomHost(rule, graph, hostPredicates);
    case 'security.manifest.source-hygiene':
    case 'security.manifest.new-dependency':
      return [];
    default: {
      const exhaustive: never = rule;
      throw new Error(`unhandled rule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
