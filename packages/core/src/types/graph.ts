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
  /** The target IS build output: it lives under a default-excluded build directory at a package
   * root or the repo root (`dist`, `build`, `out`, …). LEDGER D066 narrowed this to the case the
   * name actually describes — it used to fire for the user's `excludes` patterns and never once for
   * build output, so the one reason that could have made D052 visible per-edge never fired. */
  | 'build-output-excluded'
  /** The target was outside this scan for some OTHER recorded reason — a config `excludes` pattern,
   * a nested checkout, `node_modules`, an unreadable directory. Deliberately says only that, because
   * the scanner cannot know what a user's pattern MEANS; `UncertaintyMarker.excludedBy` carries the
   * fact the walk actually recorded. Replaces `fixture-excluded`, which no code ever produced. */
  | 'excluded-from-scan';

export interface UncertaintyMarker {
  readonly file: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
  readonly reason: UncertaintyReason;
  /**
   * For the two out-of-scope reasons above: which recorded blind spot put the target outside the
   * scan — LEDGER D066.
   *
   * The same `ScanBlindSpotReason` the walk already stores on `blindSpots`, not a second vocabulary,
   * so the per-edge marker and the per-subtree record cannot describe the same event differently.
   * Absent for every other reason (an unresolvable specifier has no blind spot behind it).
   */
  readonly excludedBy?: ScanBlindSpotReason;
}

/**
 * Why the walk did not look at a path (ADR 028). Every variant is a way a file that physically
 * exists is absent from `DependencyGraph.nodes` — which consumers of absence (`applyMoves` infers
 * "renamed", `store.prune` infers "fixed", `validateComponents` infers "empty component") would
 * otherwise read as "deleted from the repository".
 *
 * A discriminated union rather than a bare string so a new blind spot cannot be added without the
 * `never` arms in its consumers failing to compile — ADR 027's lesson that changing what a scan
 * sees is never local to scanning, enforced instead of documented.
 */
export type ScanBlindSpotReason =
  /** Carries its own `.git` — worktree, submodule, vendored clone (ADR 027). Opted back in via
   * `includeNestedCheckouts`. */
  | { readonly kind: 'nested-checkout' }
  /** Matched a config `excludes` pattern, which is recorded so the advisory can name the pattern
   * responsible rather than leaving the user to guess which one hid the path. */
  | { readonly kind: 'excluded'; readonly pattern: string }
  /** Matched `DEFAULT_EXCLUDED_DIR_NAMES` (`node_modules`, `dist`, …) at any depth. Latent across
   * versions: the set has grown, and an entry accepted under an older align can fall behind a name
   * added later. */
  | { readonly kind: 'default-excluded-dir'; readonly name: string }
  /** The bytes could not be obtained — permissions, a directory racing deletion mid-walk, a path
   * component that is not a directory. Silent before ADR 028, and one of the two reproduced
   * severity-zeros. */
  | { readonly kind: 'unreadable'; readonly error: string }
  /** The bytes were obtained but could not be understood — a malformed `package.json`, a
   * `pnpm-workspace.yaml` that is not valid YAML. Deliberately DISTINCT from `unreadable`: this is
   * the corrupt-≠-absent discipline BUG #1 established, and the two want different advice. An
   * unreadable path is usually an accident of permissions; an unparseable one is a file the user
   * can open and fix, and telling them "unreadable" would send them looking at the wrong thing.
   * ADR 028 names malformed-treated-as-absent as the same defect class occurring in a second
   * walker, which is what this variant exists to stop. */
  | { readonly kind: 'unparseable'; readonly error: string }
  /** Neither a regular file nor a directory: symlink, FIFO, socket. `readdirSync(…, {
   * withFileTypes: true })` does not follow links, so `isDirectory()` and `isFile()` are BOTH false
   * for a symlink and it matches neither branch of the walk — an entire symlinked subtree vanishes
   * with no record. Reproduced against the built scanner; see ADR 028. */
  | { readonly kind: 'not-regular-file' };

/**
 * One path the walk declined to enumerate, and why. Matching against a baseline entry is
 * at-or-under `path` (a directory blind spot covers everything beneath it), through the single
 * containment test in `baseline/scan-blind-spots.ts` — never re-implemented per consumer.
 */
export interface ScanBlindSpot {
  readonly path: RepoRelativePath;
  readonly reason: ScanBlindSpotReason;
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
  // ADR 028: every path this walk declined to look at, with the reason. Generalizes task #25's
  // `skippedNestedCheckouts` (now the `nested-checkout` variant) to the other five ways a present
  // file is absent from `nodes` — three of which were unknown when ADR 027 was written.
  //
  // A SEPARATE array from `uncertain` (not another `UncertaintyReason`) for the reason ADR 027
  // gives: these are whole skipped subtrees, not per-specifier markers, and folding them in would
  // hide a scan-scope fact among hundreds of unresolved-import markers.
  //
  // Required, never optional — ADR 027 records this release's own counter-example, where the
  // optional form of the identical parameter let a production call site silently keep pre-fix
  // behaviour with no type error.
  readonly blindSpots: readonly ScanBlindSpot[];
  readonly scannedAt: number; // epoch ms — the freshness proof underlying ADR 005
}
