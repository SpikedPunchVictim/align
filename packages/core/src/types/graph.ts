import type { ComponentName, RepoRelativePath } from './branded.js';

export type EdgeKind = 'import' | 'reexport' | 'dynamic' | 'type-only';

export interface DependencyGraphNode {
  readonly file: RepoRelativePath;
  readonly component: ComponentName;
  readonly loc: number;
  readonly exports: readonly string[];
}

export interface DependencyGraphEdge {
  readonly from: RepoRelativePath;
  readonly to: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
  readonly kind: EdgeKind; // type-only is first-class, 32% of edges measured (ADR 004)
  // DEVIATION from docs/core-interfaces.md: added `snippet` (the exact source line at `line`).
  // Violation.snippet is a required field (ADR 006/007: fingerprint stability + dedup depend on
  // it) and RuleEvaluator is a pure, I/O-free function over the graph — without the source text
  // captured on the edge at scan time, evaluators would have no way to populate a required field.
  // The scanner already holds file text in memory when it extracts the edge; capturing the line
  // here costs nothing extra and keeps evaluators pure.
  readonly snippet: string;
}

export type UncertaintyReason =
  | 'non-literal-dynamic-specifier' // spike: 1 in 456K LOC, 15 in 3.23M LOC
  | 'unresolvable-specifier'
  | 'asset-specifier' // .css/.svg/.vue/.json-ish — not graph uncertainty (ADR 004)
  | 'build-output-excluded' // configurable excludes, e.g. .stage/, dist-bundle/
  | 'fixture-excluded'; // human consent decision, not a layout heuristic (ADR 003)

export interface UncertaintyMarker {
  readonly file: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
  readonly reason: UncertaintyReason;
}

export interface DependencyGraph {
  readonly nodes: readonly DependencyGraphNode[];
  readonly edges: readonly DependencyGraphEdge[];
  readonly uncertain: readonly UncertaintyMarker[];
  readonly scannedAt: number; // epoch ms — the freshness proof underlying ADR 005
}
