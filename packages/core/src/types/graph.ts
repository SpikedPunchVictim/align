import type { ComponentName, RepoRelativePath } from './branded.js';

export type EdgeKind = 'import' | 'reexport' | 'dynamic' | 'type-only';

export interface DependencyGraphNode {
  readonly file: RepoRelativePath;
  readonly component: ComponentName;
  readonly loc: number;
  readonly exports: readonly string[];
  // DEVIATION from docs/core-interfaces.md: added `snippet` (the file's first line, trimmed), for
  // `arch.metric` (max-LOC, promoted 2026-07-12 on kluster ruleset evidence — see
  // IMPLEMENTATION_PLAN.md's Promotion log). Same rationale as `DependencyGraphEdge.snippet` below:
  // `Violation.snippet` is a required field (ADR 006/007) and `RuleEvaluator` is a pure, I/O-free
  // function over the graph, so a file-level (not edge-level) violation needs its anchor text
  // captured at scan time. The scanner already holds the file's lines in memory when computing
  // `loc`; capturing line 1 costs nothing extra.
  readonly snippet: string;
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
  // DEVIATION from docs/core-interfaces.md, added for ADR 016 (public-surface inference):
  // `kind: 'reexport' | 'type-only'` alone can't tell `export { foo } from './x'` (a NAMED
  // re-export, already fully resolved into the FROM file's own `DependencyGraphNode.exports` by
  // `exports.ts` — no further resolution needed) apart from a bare `export * from './x'` /
  // `export type * from './x'` (a barrel hop whose contents are invisible to `exports.ts` by
  // design and must be recursively resolved by `inferSurface.ts`'s transitive walk). Both produce
  // an identically-shaped edge today. `true` iff the export declaration had no named/namespace
  // export clause (`exportClause === undefined`, exports.ts:44's exact bare-star check);
  // `undefined` for every 'import'/'dynamic' edge, where the distinction doesn't apply. Optional
  // so every existing evaluator/fixture that only reads `kind` is unaffected by construction —
  // same "separate, additive field" doctrine already applied to `snippet` above and to the
  // external-node retention amendment.
  readonly isBarrelReexport?: boolean;
}

// External-package graph members (Stage 5 infra, docs/proposals/rule-expansion-evaluation.md's
// top-of-document correction #2 + the custom.host `no-child-process-outside-git-rails` dogfood
// finding in IMPLEMENTATION_PLAN.md): the scanner used to resolve+classify every external
// specifier and then discard it (`case 'external': return;`). Retained now as name-level nodes —
// one node per distinct package, not per import site — so a `custom.host` predicate can see
// "who imports what external package" via `ctx.graph` without a scanner change of its own.
// Deliberately a SEPARATE pair of arrays from `nodes`/`edges`, not merged in:
// `arch.no-dependency`/`arch.no-cycles`/`arch.layers`/`arch.metric` only ever read `nodes`/`edges`
// (file-to-file), so their semantics are unchanged by construction — no evaluator needed to be
// touched, and this is asserted by a same-count regression test on kluster/n8n rule output.
export interface ExternalPackageNode {
  // Name-level id, not per-import-site: 'external:node:child_process' for a Node builtin (the
  // `node:` prefix is normalized in regardless of whether the source used a bare or `node:`-
  // prefixed specifier) or 'external:lodash' for an npm package — stable, dedupable, and safe to
  // use directly as a Map key or an edge's `to` field.
  readonly id: string;
  readonly packageName: string; // 'child_process' | 'lodash' | '@scope/pkg'
  readonly isBuiltin: boolean;
}

export interface ExternalDependencyEdge {
  readonly from: RepoRelativePath;
  readonly to: string; // ExternalPackageNode.id
  readonly specifier: string; // the exact source specifier, e.g. 'node:child_process' or 'lodash/fp'
  readonly line: number;
  readonly kind: EdgeKind; // preserved exactly like internal edges (import/type-only/dynamic/reexport)
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
  // External-package retention (Stage 5 infra amendment to ADR 004): name-level nodes/edges,
  // excluded from every `arch.*` evaluator by construction (they only read `nodes`/`edges` above).
  // `custom.host` predicates see them via `ctx.graph.externalNodes`/`externalEdges`.
  readonly externalNodes: readonly ExternalPackageNode[];
  readonly externalEdges: readonly ExternalDependencyEdge[];
  readonly uncertain: readonly UncertaintyMarker[];
  readonly scannedAt: number; // epoch ms — the freshness proof underlying ADR 005
}
