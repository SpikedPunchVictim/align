import type { ComponentName, RepoRelativePath } from '../types/branded.js';
import { toRuleId } from '../types/branded.js';
import type { ComponentDefinitionIR, ArchLayersRule, ArchNoCyclesRule, ArchNoDependencyRule, RuleIR } from '../types/ir.js';
import type { DependencyGraph, DependencyGraphEdge, EdgeKind } from '../types/graph.js';
import type { CycleEdge, Violation } from '../types/violation.js';
import { computeFingerprint } from '../baseline/fingerprint.js';
import { extractCycleChainNodes, tarjanScc } from './tarjan.js';

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
function becauseField(because: string | undefined): { readonly because: string } | Record<string, never> {
  return because === undefined ? {} : { because };
}

export const evaluateNoDependency: RuleEvaluator<ArchNoDependencyRule> = (rule, graph) => {
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
  const violations: Violation[] = [];

  for (const layerDef of rule.layers) {
    const allowed = new Set<ComponentName>(layerDef.canDependOn as ComponentName[]);
    for (const edge of graph.edges) {
      const fromNode = nodeByFile.get(edge.from);
      const toNode = nodeByFile.get(edge.to);
      if (fromNode === undefined || toNode === undefined) continue;
      if (fromNode.component !== layerDef.layer) continue;
      if (toNode.component === fromNode.component) continue; // intra-layer is always fine
      if (allowed.has(toNode.component)) continue;

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
  }
  return violations;
};

/**
 * Exhaustive dispatcher: a new `RuleIR` discriminant without a case here is a compile error
 * (never-check, CODING_BEST_PRACTICES.md §17.2), not a silent no-op.
 */
export function evaluateRule(
  rule: RuleIR,
  graph: DependencyGraph,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
): readonly Violation[] {
  switch (rule.kind) {
    case 'arch.no-dependency':
      return evaluateNoDependency(rule, graph, components);
    case 'arch.no-cycles':
      return evaluateNoCycles(rule, graph, components);
    case 'arch.layers':
      return evaluateLayers(rule, graph, components);
    case 'custom.host':
      // v1 has no host-defined rule execution mechanism (ADR 002's escape hatch is a schema
      // slot for a future need, not an exercised v1 capability) — zero violations, not an error.
      return [];
    default: {
      const exhaustive: never = rule;
      throw new Error(`unhandled rule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
