/**
 * Core graph model for the align spike.
 * All paths are repo-relative (relative to the kluster root) with forward slashes.
 */

export type EdgeKind = 'import' | 'reexport' | 'dynamic' | 'type-only';

export interface GraphNode {
  readonly path: string;
  readonly loc: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly specifier: string;
  readonly line: number;
}

export type UncertainReason = 'non-literal-dynamic-specifier' | 'unresolvable-specifier';

export type UncertainContext = 'import' | 'reexport' | 'export-star' | 'dynamic';

export interface UncertainEdge {
  readonly file: string;
  readonly reason: UncertainReason;
  readonly context: UncertainContext;
  /** The raw specifier text when one exists (unresolvable case); absent for non-literal dynamic imports. */
  readonly specifierPreview?: string;
  readonly line: number;
}

export interface Graph {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
  readonly uncertain: readonly UncertainEdge[];
  /** External (node_modules / builtin) targets, package name only. Not traversed. */
  readonly externalPackages: ReadonlySet<string>;
}

export interface ScanStats {
  readonly wallTimeMs: number;
  readonly filesScanned: number;
  readonly totalLoc: number;
  readonly nodeCount: number;
  readonly edgeCountsByKind: Readonly<Record<EdgeKind, number>>;
  readonly uncertainCountByReason: Readonly<Record<UncertainReason, number>>;
  readonly uncertainFileCount: number;
  readonly externalPackageCount: number;
  readonly heapUsedBeforeMb: number;
  readonly heapUsedAfterMb: number;
  readonly peakHeapUsedMb: number;
}

/** Resolution outcome for one import specifier. */
export type ResolvedTarget =
  | { readonly kind: 'internal'; readonly repoRelativePath: string }
  | { readonly kind: 'external'; readonly packageName: string }
  | { readonly kind: 'unresolved' };
