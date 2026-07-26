/**
 * Transitive public-surface barrel walk (ADR 016 §"Algorithm sketch", steps 2-3): a pure function
 * over an already-materialized `DependencyGraph` plus a package's already-resolved entrypoints —
 * no fs, no Date.now(), no dependency on plugin-typescript (CODING_BEST_PRACTICES.md §14 functional
 * core / imperative shell). Mirrors `packages/agent/src/symbolDiff.ts`'s "pure diff over
 * already-collected data" placement pattern, applied one layer up (per-package instead of per-fix).
 *
 * **Deviation from the ADR's literal `(graph, entrypoints) => PackagePublicSurface` signature**:
 * `packageName` is threaded through as an explicit third parameter. `PackageEntrypoint` carries no
 * package identity of its own (by design — it's produced per-package by `entrypoint.ts`, which
 * already knows which `WorkspacePackage` it came from), so something has to supply
 * `PackagePublicSurface.packageName`; inventing it out of `entrypoints` would mean guessing at a
 * file path, which is strictly worse than the caller (which already has the `WorkspacePackage`)
 * just passing the name along.
 *
 * **Bare-star vs named re-export disambiguation**: `DependencyGraphEdge.kind: 'reexport' |
 * 'type-only'` alone cannot tell a named `export { foo } from './x'` (already fully resolved into
 * the FROM file's own `DependencyGraphNode.exports` by `exports.ts` — no further resolution
 * needed, and recursing into it would incorrectly leak every OTHER symbol `./x` happens to export)
 * apart from a bare `export * from './x'` / `export type * from './x'` (invisible to `exports.ts`
 * by design, and the one case that genuinely needs this recursive walk). This module relies on
 * `DependencyGraphEdge.isBarrelReexport` (added to core's graph type for this ADR) to make that
 * distinction — see that field's doc comment in `types/graph.ts`.
 *
 * **Confidence degradation rule**: per entrypoint, if ANY `SurfaceUncertaintyMarker` (barrel-cycle
 * or unresolvable-reexport) fires anywhere in that entrypoint's own transitive walk, EVERY
 * `PublicSurfaceEntry` that walk produced is downgraded to `'inferred-none'` — not just entries
 * reached through the specific broken branch (which, being broken, produces no entries of its own
 * to selectively downgrade). This is the "reachability is only as trustworthy as its weakest hop"
 * framing from the ADR's algorithm sketch, validated against the falsification spike's own
 * round-2 `walkEntrypoint`/`inferPackageSurface` behavior
 * (`docs/evidence/surface-inference-spike/SPIKE_REPORT.md`, `scratchpad/round2/ts_surface.js`).
 * A resolvable `inferred-unique` hop never degrades a `declared` entrypoint's entries — only
 * unresolvability (or a cycle) does. Different entrypoints of the same package (subpath exports)
 * are graded independently: one broken subpath does not degrade a sibling subpath's clean walk.
 */
import type {
  DependencyGraph,
  DependencyGraphEdge,
  DependencyGraphNode,
  PackageEntrypoint,
  PackagePublicSurface,
  PublicSurfaceEntry,
  RepoRelativePath,
  SurfaceUncertaintyMarker,
} from '../types/index.js';

// Matches the scanner's own SOURCE_EXTENSIONS (plugin-typescript/src/scanner.ts) — kept as a
// separate literal here (not imported) since core must never depend on plugin-typescript
// (`dsl -> core <- plugin-typescript`, ARCHITECTURE.md §5). Used only for the defensive
// `non-source-reexport-target` check below; see that branch's comment for why it is not expected
// to fire against a graph a real TypeScriptScanner produced.
const SOURCE_EXTENSION_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

interface SymbolHit {
  readonly declaredIn: RepoRelativePath;
  readonly reachableVia: readonly RepoRelativePath[];
}

interface FileWalkResult {
  readonly bySymbol: ReadonlyMap<string, SymbolHit>;
  readonly uncertain: readonly SurfaceUncertaintyMarker[];
}

/** Computes, as if `file` were itself an entrypoint, every symbol transitively reachable from it:
 * its own directly-declared/named-re-exported symbols (already resolved by `exports.ts` into
 * `DependencyGraphNode.exports`) plus, recursively, everything reachable through its outgoing
 * bare-star barrel edges. `pathSoFar` is the set of files already on THIS walk's path (not a
 * once-ever-visited set) — the same file reachable via two different sibling barrels is walked
 * twice, independently; only a genuine revisit of an ancestor on the current path is a cycle. */
function walkFile(
  file: RepoRelativePath,
  nodesByFile: ReadonlyMap<RepoRelativePath, DependencyGraphNode>,
  edgesByFrom: ReadonlyMap<RepoRelativePath, readonly DependencyGraphEdge[]>,
  pathSoFar: ReadonlySet<RepoRelativePath>,
): FileWalkResult {
  if (pathSoFar.has(file)) {
    return { bySymbol: new Map(), uncertain: [{ file, reason: 'barrel-cycle' }] };
  }

  const node = nodesByFile.get(file);
  if (node === undefined) {
    // Reached as a barrel target that resolved to a source-extension path but isn't among the
    // scanned nodes (e.g. a bare-star re-export into a dist-only file the scanner's own directory
    // walk skips) — named, not machinery-heavy, per ADR 004's uncertainty-vocabulary doctrine.
    return { bySymbol: new Map(), uncertain: [{ file, reason: 'unresolvable-reexport' }] };
  }

  const bySymbol = new Map<string, SymbolHit>();
  for (const symbol of node.exports) bySymbol.set(symbol, { declaredIn: file, reachableVia: [] });

  const uncertain: SurfaceUncertaintyMarker[] = [];
  const nextPath = new Set(pathSoFar);
  nextPath.add(file);

  for (const outgoing of edgesByFrom.get(file) ?? []) {
    // Named re-exports (`export { foo } from`) and namespace re-exports (`export * as ns from`)
    // are already fully resolved into `node.exports` above by exports.ts — only a bare star needs
    // this recursive walk at all.
    if (outgoing.isBarrelReexport !== true) continue;

    if (!SOURCE_EXTENSION_RE.test(outgoing.to)) {
      // Not expected to fire against a real TypeScriptScanner-produced graph: the scanner itself
      // never creates an edge to a non-source, non-asset target (recordSpecifier's 'internal'
      // branch returns early for those). Kept as a real, checked category anyway — a
      // `DependencyGraph` is a plain data contract this module doesn't assume only one producer
      // ever populates, and ADR 016 names this as a distinct reason, not a fold-in of
      // 'unresolvable-reexport'.
      uncertain.push({ file, reason: 'non-source-reexport-target' });
      continue;
    }

    if (!nodesByFile.has(outgoing.to)) {
      // Attributed to `file` (the barrel doing the re-exporting), matching this module's
      // "the file containing the problem" convention — mirrors `UncertaintyMarker.file` in
      // `types/graph.ts` (the source side of an unresolvable specifier, not the missing target).
      uncertain.push({ file, reason: 'unresolvable-reexport' });
      continue;
    }

    const sub = walkFile(outgoing.to, nodesByFile, edgesByFrom, nextPath);
    uncertain.push(...sub.uncertain);
    for (const [symbol, hit] of sub.bySymbol) {
      // ECMAScript semantics: a bare `export * from 'mod'` never re-exports `default`, only named
      // bindings — a barrel file's own `export default` (if any) is unaffected, this only blocks
      // propagating a TARGET's default further up through a star re-export.
      if (symbol === 'default') continue;
      // Entrypoint-facing (or earlier-resolved-edge) name wins on conflict — matches the priority
      // order the falsification spike's round-2 script validated.
      if (bySymbol.has(symbol)) continue;
      bySymbol.set(symbol, { declaredIn: hit.declaredIn, reachableVia: [outgoing.to, ...hit.reachableVia] });
    }
  }

  return { bySymbol, uncertain };
}

/** The pure barrel-walk algorithm (ADR 016 §"Where it lives"). */
export function inferSurface(
  graph: DependencyGraph,
  packageName: string,
  entrypoints: readonly PackageEntrypoint[],
): PackagePublicSurface {
  const nodesByFile = new Map(graph.nodes.map((n) => [n.file, n] as const));
  const edgesByFrom = new Map<RepoRelativePath, DependencyGraphEdge[]>();
  for (const edge of graph.edges) {
    const existing = edgesByFrom.get(edge.from);
    if (existing === undefined) edgesByFrom.set(edge.from, [edge]);
    else existing.push(edge);
  }

  const exports: PublicSurfaceEntry[] = [];
  const uncertain: SurfaceUncertaintyMarker[] = [];

  for (const entrypoint of entrypoints) {
    // 'inferred-none' entrypoints (file: null) contribute no entries — a package-level signal
    // only, per the ADR's typed contract (illegal to even construct a symbol-bearing entry for a
    // never-resolved entrypoint since there is no file to walk from).
    if (entrypoint.file === null) continue;

    const walk = walkFile(entrypoint.file, nodesByFile, edgesByFrom, new Set());
    uncertain.push(...walk.uncertain);

    const confidence = walk.uncertain.length > 0 ? 'inferred-none' : entrypoint.confidence;
    for (const [symbol, hit] of walk.bySymbol) {
      exports.push({ symbol, declaredIn: hit.declaredIn, reachableVia: hit.reachableVia, confidence });
    }
  }

  return { packageName, entrypoints, exports, uncertain };
}
