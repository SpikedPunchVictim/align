/**
 * Rule model + evaluators. Both evaluators are pure functions over the graph:
 * (Graph, rules, classify) -> Violation[]. No I/O.
 */

import { classifyFile } from './components.js';
import type { EdgeKind, Graph, GraphEdge } from './types.js';

export interface NoDependencyRule {
  readonly id: string;
  readonly kind: 'no-dependency';
  readonly from: string;
  readonly to: string;
  readonly rationale: string;
}

export interface NoCyclesRule {
  readonly id: string;
  readonly kind: 'no-cycles';
  readonly scope: 'repo' | { readonly component: string };
  readonly edgeKinds: readonly EdgeKind[];
  readonly rationale: string;
}

export type Rule = NoDependencyRule | NoCyclesRule;

export type Violation =
  | {
      readonly ruleId: string;
      readonly kind: 'no-dependency';
      readonly fromFile: string;
      readonly toFile: string;
      readonly specifier: string;
      readonly line: number;
      readonly message: string;
      readonly fixHint: string;
    }
  | {
      readonly ruleId: string;
      readonly kind: 'no-cycles';
      readonly chain: readonly string[];
      readonly message: string;
      readonly fixHint: string;
    };

export const RULES: readonly Rule[] = [
  {
    id: 'no-ui-import-in-api',
    kind: 'no-dependency',
    from: 'api-app',
    to: 'ui-app',
    rationale: 'The API must remain headless: backend code must never couple to React/frontend modules.',
  },
  {
    id: 'bt-core-isolated',
    kind: 'no-dependency',
    from: 'bt-core',
    to: 'bt-nodes',
    rationale:
      'Dependency inversion: the behavior-tree engine (bt-core) defines contracts; node plugins and the CLI depend on it, never the reverse.',
  },
  {
    id: 'llm-providers-no-node-reach',
    kind: 'no-dependency',
    from: 'llm-providers',
    to: 'bt-nodes',
    rationale:
      'LLM provider adapters are leaf libraries; importing node plugins would invert the plugin layering.',
  },
  {
    id: 'no-runtime-cycles',
    kind: 'no-cycles',
    scope: 'repo',
    // type-only edges deliberately excluded: mutually-referencing interface files are
    // common and benign; runtime cycles are the actionable ones for this spike.
    edgeKinds: ['import', 'reexport', 'dynamic'],
    rationale: 'Runtime import cycles cause partially-initialized-module bugs and block tree-shaking.',
  },
  {
    id: 'app-no-tooling-dependency',
    kind: 'no-dependency',
    from: 'api-app',
    to: 'fold-workbench',
    rationale:
      'Shipping application code must not depend on internal build-pipeline workbench tooling.',
  },
];

export interface RuleEvaluation {
  readonly rule: Rule;
  readonly violations: readonly Violation[];
}

export function evaluateRules(graph: Graph, rules: readonly Rule[]): RuleEvaluation[] {
  return rules.map((rule) => ({ rule, violations: evaluateRule(graph, rule) }));
}

export function evaluateRule(graph: Graph, rule: Rule): Violation[] {
  switch (rule.kind) {
    case 'no-dependency':
      return evaluateNoDependency(graph, rule);
    case 'no-cycles':
      return evaluateNoCycles(graph, rule);
    default: {
      const _exhaustive: never = rule;
      throw new Error(`unhandled rule kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function evaluateNoDependency(graph: Graph, rule: NoDependencyRule): Violation[] {
  const violations: Violation[] = [];
  for (const edge of graph.edges) {
    if (classifyFile(edge.from) !== rule.from) continue;
    if (classifyFile(edge.to) !== rule.to) continue;
    violations.push({
      ruleId: rule.id,
      kind: 'no-dependency',
      fromFile: edge.from,
      toFile: edge.to,
      specifier: edge.specifier,
      line: edge.line,
      message: `'${edge.from}' (component '${rule.from}') imports '${edge.to}' (component '${rule.to}') via '${edge.specifier}' at line ${edge.line}, which rule '${rule.id}' forbids: ${rule.rationale}`,
      fixHint:
        `Remove or invert this dependency. Options: (a) delete the import at ${edge.from}:${edge.line} if unused; ` +
        `(b) move the shared code out of '${rule.to}' into a component both sides may depend on; ` +
        `(c) invert the dependency via an interface owned by '${rule.from}' and implemented in '${rule.to}'.`,
    });
  }
  return violations;
}

function evaluateNoCycles(graph: Graph, rule: NoCyclesRule): Violation[] {
  const allowedKinds = new Set(rule.edgeKinds);
  const inScope = (file: string): boolean =>
    rule.scope === 'repo' ? true : classifyFile(file) === rule.scope.component;

  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes.keys()) {
    if (inScope(node)) adjacency.set(node, []);
  }
  const scopedEdges: GraphEdge[] = [];
  for (const edge of graph.edges) {
    if (!allowedKinds.has(edge.kind)) continue;
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
    scopedEdges.push(edge);
  }

  const sccs = tarjanScc(adjacency);
  const violations: Violation[] = [];
  for (const scc of sccs) {
    const isCycle = scc.length > 1 || hasSelfLoop(scc, scopedEdges);
    if (!isCycle) continue;
    const chain = extractCycleChain(scc, adjacency);
    violations.push({
      ruleId: rule.id,
      kind: 'no-cycles',
      chain,
      message:
        `Import cycle of ${scc.length} file(s) detected in scope ` +
        `'${rule.scope === 'repo' ? 'repo' : rule.scope.component}': ${chain.join(' -> ')}. ${rule.rationale}`,
      fixHint:
        `Break one edge in the chain: typically extract the shared symbols into a new module both sides import, ` +
        `or replace the back-edge (last arrow in the chain) with an interface/type-only import.`,
    });
  }
  return violations;
}

function hasSelfLoop(scc: readonly string[], edges: readonly GraphEdge[]): boolean {
  if (scc.length !== 1) return false;
  const node = scc[0];
  return edges.some((e) => e.from === node && e.to === node);
}

/** Walk within the SCC from its first node until we revisit it, yielding one concrete cycle. */
function extractCycleChain(scc: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): string[] {
  const inScc = new Set(scc);
  const start = scc[0];
  if (start === undefined) return [];
  const chain: string[] = [start];
  const seen = new Set<string>([start]);
  let current = start;
  for (let i = 0; i < scc.length + 1; i += 1) {
    const neighbors: readonly string[] = adjacency.get(current) ?? [];
    if (current !== start && neighbors.includes(start)) {
      chain.push(start); // prefer closing the loop over wandering the SCC
      return chain;
    }
    const next: string | undefined = neighbors.find((n) => inScc.has(n) && !seen.has(n));
    if (next === undefined) break;
    chain.push(next);
    if (next === start) return chain;
    seen.add(next);
    current = next;
  }
  return chain; // partial chain (still informative) if a tidy loop was not found
}

/** Iterative Tarjan strongly-connected-components. */
function tarjanScc(adjacency: ReadonlyMap<string, readonly string[]>): string[][] {
  let index = 0;
  const nodeIndex = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  interface Frame {
    readonly node: string;
    childIdx: number;
  }

  for (const root of adjacency.keys()) {
    if (nodeIndex.has(root)) continue;
    const frames: Frame[] = [{ node: root, childIdx: 0 }];
    nodeIndex.set(root, index);
    lowLink.set(root, index);
    index += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const neighbors = adjacency.get(frame.node) ?? [];

      if (frame.childIdx < neighbors.length) {
        const next: string | undefined = neighbors[frame.childIdx];
        frame.childIdx += 1;
        if (next === undefined) continue;
        if (!nodeIndex.has(next)) {
          nodeIndex.set(next, index);
          lowLink.set(next, index);
          index += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, childIdx: 0 });
        } else if (onStack.has(next)) {
          const nl = lowLink.get(frame.node) ?? 0;
          lowLink.set(frame.node, Math.min(nl, nodeIndex.get(next) ?? 0));
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        const pl = lowLink.get(parent.node) ?? 0;
        lowLink.set(parent.node, Math.min(pl, lowLink.get(frame.node) ?? 0));
      }
      if (lowLink.get(frame.node) === nodeIndex.get(frame.node)) {
        const scc: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          scc.push(popped);
          if (popped === frame.node) break;
        }
        sccs.push(scc);
      }
    }
  }
  return sccs;
}
