import { globMatch } from '../components/glob.js';
import type { RepoRelativePath } from '../types/branded.js';
import type { DependencyGraph } from '../types/graph.js';

/**
 * ADR 020 (ACCEPTED, RESCOPED to a `doctor` advisory) -- "the deep-import convention check", the
 * #3-shaped precedent (`ungoverned-edges.ts`) applied to a different silence: a cross-package
 * import that reaches PAST a package's declared public surface into its internals (a specifier
 * subpath containing a `src`/`dist`/`lib`/`internal` path segment, e.g.
 * `n8n-nodes-base/dist/nodes/Set/v2/helpers/interfaces`). Invisible to `tsc` (the deep path still
 * resolves and type-checks) and to most ESLint configs. Not a new rule kind -- the ADR's placebo
 * test found this repo-dependent (vscode ~31% precision), below the blocking bar -- a doctor
 * advisory only, same as #3.
 */
export interface DeepImportHit {
  readonly from: RepoRelativePath;
  readonly line: number;
  readonly specifier: string; // exact import text
  readonly targetPackage: string; // parsed package name
  readonly subpath: string; // the part after the package name
  readonly marker: string; // which of the configured markers matched
}

const DEFAULT_MARKERS: readonly string[] = ['src', 'dist', 'lib', 'internal'];

/** A raw specifier occurrence, normalized across the three graph sources this reads (each has a
 * differently-named "which file" field -- `from` on edges, `file` on uncertainty markers). */
interface SpecifierOccurrence {
  readonly file: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
}

/**
 * Mirrors `packageNameFromSpecifier` (`plugin-typescript/src/tsconfig-resolver.ts:148-153`)
 * faithfully rather than importing it: core must not depend on a language-plugin package
 * (monorepo dependency-direction rule -- plugins depend on core, never the reverse), so the
 * (small, stable) parsing logic is replicated here instead of shared across that boundary.
 * Package name is the first 1 (unscoped) or 2 (`@scope/name`) segments of the specifier.
 */
function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return specifier;
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}

/** A deep-import convention is about *cross-package* reach only -- a relative (`./`) or absolute
 * (`/`) specifier never targets another package's internals, and a `#`-prefixed specifier is a Node
 * subpath import resolving WITHIN the importing package (via its own `imports` map), so it's
 * package-internal by definition -- all out of scope. (tsconfig path aliases like `~/x` or `@/x`
 * are indistinguishable from real package specifiers without resolver knowledge core doesn't hold;
 * that FP class is documented in ADR 020 as repo-dependent, advisory-only.) */
function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#');
}

/** Splits a package specifier into its package name and subpath (everything after). A bare
 * import with no subpath (`'lib'`, `'@scope/lib'`) yields an empty subpath. */
function splitPackageSpecifier(specifier: string): { targetPackage: string; subpath: string } {
  const targetPackage = packageNameFromSpecifier(specifier);
  const subpath = specifier === targetPackage ? '' : specifier.slice(targetPackage.length + 1);
  return { targetPackage, subpath };
}

/** Flags iff a subpath PATH SEGMENT (not a substring, and never the package-name segment) equals
 * one of the configured markers -- this is what keeps `@scope/lib` and a package literally named
 * `lib` from false-matching on their own name, and returns the first matching segment in path
 * order for a deterministic, human-legible `marker` field. */
function firstMatchingMarker(subpath: string, markers: readonly string[]): string | undefined {
  if (subpath === '') return undefined;
  const markerSet = new Set(markers);
  for (const segment of subpath.split('/')) {
    if (markerSet.has(segment)) return segment;
  }
  return undefined;
}

/** Allowlist entries are globs matched against `package + '/' + subpath` (e.g. `typescript/lib/*`
 * suppresses `typescript/lib/foo`). Reuses align's own minimal glob matcher (`components/glob.ts`)
 * -- the same dialect selectors already use -- rather than adding a dependency. */
function isAllowlisted(targetPackage: string, subpath: string, allowlist: readonly string[]): boolean {
  const key = `${targetPackage}/${subpath}`;
  return allowlist.some((pattern) => globMatch(pattern, key));
}

/**
 * Computes every deep-import-convention hit in the graph, ranked by (targetPackage, subpath)
 * frequency desc, then targetPackage/subpath/file/line for deterministic tie-breaking.
 *
 * Reads over THREE graph sources -- `edges` (internal cross-component, e.g. a workspace package
 * resolved by name), `externalEdges` (to node_modules/builtins), AND `uncertain`. The third is the
 * false-quiet fix (ADR 020): `ts.resolveModuleName` can't resolve an unbuilt `dist/` subpath or an
 * uninstalled dependency, so the scanner routes it to `graph.uncertain` (`kind: 'unresolved'`,
 * `tsconfig-resolver.ts:47-59`), not `edges`/`externalEdges` -- an edges-only reader sees ~nothing
 * in exactly the uninstalled/unbuilt repos this check targets. Markers are pure text match over
 * the raw specifier, so `uncertain`'s `specifier`/`file`/`line` fields work exactly like an edge's.
 *
 * Pure over the graph -- no I/O, no filesystem, no manifest/exports resolution (that's the
 * Arm-B exports-aware machinery the ADR's placebo test found not worth its cost).
 */
export function computeDeepImportHits(
  graph: DependencyGraph,
  opts: { markers?: readonly string[]; allowlist?: readonly string[] } = {},
): DeepImportHit[] {
  const markers = opts.markers ?? DEFAULT_MARKERS;
  const allowlist = opts.allowlist ?? [];

  const occurrences: SpecifierOccurrence[] = [];
  for (const e of graph.edges) occurrences.push({ file: e.from, specifier: e.specifier, line: e.line });
  for (const e of graph.externalEdges) occurrences.push({ file: e.from, specifier: e.specifier, line: e.line });
  for (const u of graph.uncertain) {
    // An ASSET is not a deep import (LEDGER D055). The scanner has already classified this
    // specifier — `reason: 'asset-specifier'` — and flattening the marker to {file, specifier, line}
    // discarded the one fact that answers the question, one line before it is asked. A stylesheet
    // has no public surface to reach past; `import 'reactflow/dist/style.css'` was reported as
    // "reaches past reactflow's public surface via 'dist'".
    //
    // Filtered on the REASON, not on the file extension: `graph.uncertain` is a legitimate source of
    // deep-import occurrences (a specifier align could not resolve is still worth reporting), so
    // dropping the collection wholesale would narrow the check far past the defect.
    if (u.reason === 'asset-specifier') continue;
    occurrences.push({ file: u.file, specifier: u.specifier, line: u.line });
  }

  const hits: DeepImportHit[] = [];
  for (const { file, specifier, line } of occurrences) {
    if (!isPackageSpecifier(specifier)) continue;
    const { targetPackage, subpath } = splitPackageSpecifier(specifier);
    const marker = firstMatchingMarker(subpath, markers);
    if (marker === undefined) continue;
    if (isAllowlisted(targetPackage, subpath, allowlist)) continue;
    hits.push({ from: file, line, specifier, targetPackage, subpath, marker });
  }

  // Frequency of the exact (targetPackage, subpath) pair across the whole graph -- a widely
  // repeated deep import is a stronger "this is a real convention worth fixing" signal than a
  // one-off, same ranking rationale as ungoverned-edges' edge-weight.
  const frequency = new Map<string, number>();
  for (const hit of hits) {
    const key = `${hit.targetPackage}/${hit.subpath}`;
    frequency.set(key, (frequency.get(key) ?? 0) + 1);
  }

  hits.sort((a, b) => {
    const freqA = frequency.get(`${a.targetPackage}/${a.subpath}`) ?? 0;
    const freqB = frequency.get(`${b.targetPackage}/${b.subpath}`) ?? 0;
    return (
      freqB - freqA ||
      a.targetPackage.localeCompare(b.targetPackage) ||
      a.subpath.localeCompare(b.subpath) ||
      a.from.localeCompare(b.from) ||
      a.line - b.line
    );
  });

  return hits;
}
