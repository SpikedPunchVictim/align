import { toComponentName, toRepoRelativePath } from '../src/types/branded.js';
import type { RepoRelativePath } from '../src/types/branded.js';
import type {
  DependencyGraph,
  DependencyGraphEdge,
  DependencyGraphNode,
  EdgeKind,
  ExternalDependencyEdge,
  ExternalPackageNode,
  ScanBlindSpot,
  UncertaintyMarker,
  UncertaintyReason,
} from '../src/types/graph.js';

export function node(file: string, component: string, loc = 10, snippet?: string): DependencyGraphNode {
  return {
    file: toRepoRelativePath(file),
    component: toComponentName(component),
    loc,
    exports: [],
    snippet: snippet ?? `// ${file}`,
  };
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

export function externalNode(packageName: string, isBuiltin = false): ExternalPackageNode {
  return { id: isBuiltin ? `external:node:${packageName}` : `external:${packageName}`, packageName, isBuiltin };
}

export function externalEdge(
  from: string,
  packageName: string,
  opts: { isBuiltin?: boolean; specifier?: string; line?: number; kind?: EdgeKind; snippet?: string } = {},
): ExternalDependencyEdge {
  const isBuiltin = opts.isBuiltin ?? false;
  const specifier = opts.specifier ?? packageName;
  return {
    from: toRepoRelativePath(from),
    to: isBuiltin ? `external:node:${packageName}` : `external:${packageName}`,
    specifier,
    line: opts.line ?? 1,
    kind: opts.kind ?? 'import',
    snippet: opts.snippet ?? `import x from '${specifier}';`,
  };
}

export function uncertainMarker(
  file: string,
  specifier: string,
  opts: { line?: number; reason?: UncertaintyReason } = {},
): UncertaintyMarker {
  return {
    file: toRepoRelativePath(file),
    specifier,
    line: opts.line ?? 1,
    reason: opts.reason ?? 'unresolvable-specifier',
  };
}

export function graph(
  nodes: DependencyGraphNode[],
  edges: DependencyGraphEdge[],
  external: {
    readonly nodes?: ExternalPackageNode[];
    readonly edges?: ExternalDependencyEdge[];
    readonly uncertain?: UncertaintyMarker[];
    readonly blindSpots?: readonly ScanBlindSpot[];
  } = {},
): DependencyGraph {
  return {
    nodes,
    edges,
    externalNodes: external.nodes ?? [],
    externalEdges: external.edges ?? [],
    uncertain: external.uncertain ?? [],
    blindSpots: external.blindSpots ?? [],
    scannedAt: Date.now(),
  };
}

/** A `ScanBlindSpot` for tests. Defaults to the `nested-checkout` reason because that is the
 * variant every pre-ADR-028 test was written against (they passed bare paths), so re-pointing them
 * onto this helper keeps them testing the SAME fact rather than a weaker one. */
export function blindSpot(path: string, reason: ScanBlindSpot['reason'] = { kind: 'nested-checkout' }): ScanBlindSpot {
  return { path: toRepoRelativePath(path), reason };
}
