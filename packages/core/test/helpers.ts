import { toComponentName, toRepoRelativePath } from '../src/types/branded.js';
import type { DependencyGraph, DependencyGraphEdge, DependencyGraphNode, EdgeKind } from '../src/types/graph.js';

export function node(file: string, component: string, loc = 10): DependencyGraphNode {
  return { file: toRepoRelativePath(file), component: toComponentName(component), loc, exports: [] };
}

export function edge(
  from: string,
  to: string,
  opts: { specifier?: string; line?: number; kind?: EdgeKind; snippet?: string } = {},
): DependencyGraphEdge {
  const specifier = opts.specifier ?? to;
  return {
    from: toRepoRelativePath(from),
    to: toRepoRelativePath(to),
    specifier,
    line: opts.line ?? 1,
    kind: opts.kind ?? 'import',
    snippet: opts.snippet ?? `import x from '${specifier}';`,
  };
}

export function graph(nodes: DependencyGraphNode[], edges: DependencyGraphEdge[]): DependencyGraph {
  return { nodes, edges, uncertain: [], scannedAt: Date.now() };
}
