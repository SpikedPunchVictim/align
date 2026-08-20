import * as fs from 'node:fs';
import * as path from 'node:path';
import { lintGlobPattern } from '@spikedpunch/align-core';
import { loadWorkspacePackages, readWorkspaceGlobs, type WorkspacePackage } from '@spikedpunch/align-plugin-typescript';

export interface DetectedComponent {
  readonly name: string;
  readonly pattern: string; // glob selector, e.g. 'packages/core/**'
}

/**
 * Mechanical component auto-detection for `align init`. Groups by the *fixed (non-wildcard)
 * prefix* of each workspace glob pattern rather than one component per package — a
 * generically-implementable heuristic that keeps the starter component count small without
 * requiring the hand-curated judgment calls the spike applied to kluster (documented limitation:
 * less semantically precise than a human-reviewed component map, but zero-config and directionally
 * correct for the common "packages/*, application/*" monorepo shape). Workspace globs come from
 * whichever package manager declared them (pnpm-workspace.yaml or package.json `workspaces`), read
 * once by the shared `readWorkspaceGlobs` — no PM-specific parsing duplicated here.
 */
/** Above this many resolved packages, one-component-per-package produces an unreviewable starter
 * config (backstage has 255) — the coarse prefix group is the better default there. Below it,
 * naming each package is what makes inter-package boundaries governable at all. A starter-config
 * heuristic the human reviews and edits, not a gating rule (cf. ADR 019's rejection of heuristics
 * for enforcement — this is suggestion). */
const MAX_PER_PACKAGE_COMPONENTS = 25;

/**
 * Splits detected components by whether align's glob dialect can express their selector at all —
 * LEDGER D045's `align init` half.
 *
 * Every detected pattern is `${directoryName}/**`, and a directory name is free to contain
 * characters the dialect reserves or does not support: `(`, `)`, `[`, `]`, `|`. There is no escape
 * syntax (`components/glob.ts` is a deliberately minimal hand-rolled matcher), so such a directory
 * genuinely cannot be selected — the pattern is not merely awkward, it is unexpressible. Writing it
 * into `align.config.ts` anyway is what produced D041's stuck repository and, once the dialect lint
 * became reachable at scan time, a hard load failure on the very next command.
 *
 * A partition rather than a filter: the caller must be able to SAY which directories it dropped.
 * Silently omitting a component leaves a directory ungoverned with no trace anywhere — no advisory,
 * no ungrounded-component entry, nothing — and an unreported omission is the shape this project
 * ranks worst.
 */
export function partitionByGlobDialect(detected: readonly DetectedComponent[]): {
  readonly expressible: DetectedComponent[];
  readonly inexpressible: DetectedComponent[];
} {
  const expressible: DetectedComponent[] = [];
  const inexpressible: DetectedComponent[] = [];
  for (const component of detected) {
    (lintGlobPattern(component.pattern) === undefined ? expressible : inexpressible).push(component);
  }
  return { expressible, inexpressible };
}

export function detectComponents(rootDir: string): DetectedComponent[] {
  const patterns = readWorkspaceGlobs(rootDir);
  // Declared workspace globs are only trustworthy if they resolve to REAL packages. A stale or
  // config-only `lerna.json` (no `packages` field → `readWorkspaceGlobs` injects the synthetic
  // `packages/*` default), or a genuinely empty monorepo, yields globs that match nothing;
  // committing to them would emit a `packages/**` component matching ZERO files and leave the
  // repo's actual `src/` tree unmapped. Resolve once and fall through to directory/single-package
  // detection when nothing resolves (restores the pre-lerna behavior for those repos).
  const packages = patterns.length > 0 ? loadWorkspacePackages(rootDir) : [];
  if (packages.length > 0) {
    const grouped = detectFromWorkspaceGlobs(patterns);
    // A single fixed-prefix workspace (lerna's `packages/*`, a lone `packages/*` in package.json)
    // lumps every member into one component, hiding exactly the inter-package boundaries a monorepo
    // user wants to govern (the "nest = 1 component" collapse). When that lone group resolves to a
    // reviewable number of packages, name them individually instead. Only the single-prefix case is
    // touched — a multi-prefix workspace already yields >1 group and stays coarse, unchanged.
    if (grouped.length === 1 && packages.length >= 2 && packages.length <= MAX_PER_PACKAGE_COMPONENTS) {
      return perPackageComponents(packages);
    }
    return grouped;
  }
  const fromDirs = detectFromTopLevelPackageDirs(rootDir);
  if (fromDirs.length > 0) return fromDirs;
  return detectSinglePackage(rootDir);
}

/** One component per resolved workspace package, named from its directory's last segment and scoped
 * to that directory — the granular alternative to prefix-grouping for small single-prefix
 * workspaces. Disjoint package dirs never overlap, so classification order is cosmetic; sorted by
 * name for deterministic, readable output. */
function perPackageComponents(packages: readonly WorkspacePackage[]): DetectedComponent[] {
  const components = packages.map((p) => {
    const dir = p.dir.replace(/\/$/, '');
    return { name: sanitizeName(lastSegment(dir)), pattern: `${dir}/**` };
  });
  components.sort((a, b) => a.name.localeCompare(b.name));
  return dedupeNames(components);
}

function detectFromWorkspaceGlobs(patterns: readonly string[]): DetectedComponent[] {
  const prefixes = new Set<string>();
  for (const pattern of patterns) prefixes.add(fixedPrefix(pattern));

  const components = [...prefixes]
    .sort((a, b) => b.length - a.length) // longest/most-specific prefix classifies first
    .map((prefix) => ({ name: sanitizeName(lastSegment(prefix)), pattern: `${prefix}/**` }));

  return dedupeNames(components);
}

function fixedPrefix(pattern: string): string {
  const segments = pattern.split('/');
  const idx = segments.findIndex((s) => s.includes('*'));
  const prefixSegments = idx === -1 ? segments : segments.slice(0, idx);
  return (prefixSegments.length > 0 ? prefixSegments.join('/') : segments[0]) || pattern;
}

function lastSegment(prefix: string): string {
  const segments = prefix.split('/');
  return segments[segments.length - 1] ?? prefix;
}

/** Component names double as `c.<name>` property accesses and unquoted object-literal keys in
 * the generated DSL (render-config.ts), so they must be valid JS identifiers — not just valid
 * against the IR's `^[A-Za-z][A-Za-z0-9_-]*$` ComponentName pattern, which permits hyphens that
 * `c.kluster-bt` would then parse as a subtraction expression. camelCase rather than hyphenate. */
function sanitizeName(raw: string): string {
  const stripped = raw.replace(/^@/, '');
  const camel = stripped
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join('');
  return /^[A-Za-z]/.test(camel) ? camel : `c${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

function dedupeNames(components: DetectedComponent[]): DetectedComponent[] {
  const seen = new Map<string, number>();
  return components.map((c) => {
    const count = seen.get(c.name) ?? 0;
    seen.set(c.name, count + 1);
    // Numeric suffix with NO hyphen: a collision-renamed `foo-2` is a valid IR ComponentName but
    // parses as `c.foo - 2` (subtraction) in the generated DSL — the exact hazard `sanitizeName`
    // exists to prevent. Per-package detection (`packages/a/utils` + `packages/b/utils`) makes this
    // collision realistic, so keep the suffix identifier-safe: `foo2`.
    return count === 0 ? c : { ...c, name: `${c.name}${count + 1}` };
  });
}

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Build-output dir names skipped by the source-dir branch — a `dist/`/`out/` full of emitted
 * `.js` is not a source component. Kept minimal and unambiguously build-output (dotdirs are already
 * skipped by the caller); mirrors the scanner/doctor exclusion intent without coupling to it. */
const BUILD_OUTPUT_DIR_NAMES = new Set(['dist', 'build', 'out', 'coverage']);

/** True if `absDir` (or its immediate `src/` subdir) directly contains a source file — the signal
 * that a top-level directory is a source component even without a `package.json` of its own. */
function containsSource(absDir: string): boolean {
  return hasSourceFileDirectlyIn(absDir) || hasSourceFileDirectlyIn(path.join(absDir, 'src'));
}

function hasSourceFileDirectlyIn(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && SOURCE_EXTENSIONS.some((ext) => e.name.endsWith(ext)));
}

/**
 * Top-level directories as components, for a repo with no workspace declaration. A dir qualifies if
 * it holds a `package.json` (the original behavior). Additionally — only when at least one such
 * package dir exists — a top-level dir with NO `package.json` that directly contains source is also
 * mapped: this is the "vscode = 6,234 unmapped" collapse, where the ~6k-file `src/` core has no
 * `package.json` and was left unbound while `extensions/`/`build/` (which do) became components.
 *
 * The "alongside packages" guard matters: a plain single-package app (only `src/`, no package dirs)
 * must keep falling through to `detectSinglePackage`'s `app` component rather than being renamed to
 * `src`, so the source-dir branch is deliberately inert unless a package dir is already present.
 */
function detectFromTopLevelPackageDirs(rootDir: string): DetectedComponent[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');

  const packageDirs = dirs.filter((e) => fs.existsSync(path.join(rootDir, e.name, 'package.json')));
  if (packageDirs.length === 0) return []; // single-package repo — let detectSinglePackage name it `app`

  const sourceDirs = dirs.filter(
    (e) =>
      !fs.existsSync(path.join(rootDir, e.name, 'package.json')) &&
      !BUILD_OUTPUT_DIR_NAMES.has(e.name) &&
      containsSource(path.join(rootDir, e.name)),
  );

  const components = [...packageDirs, ...sourceDirs].map((e) => ({ name: sanitizeName(e.name), pattern: `${e.name}/**` }));
  return dedupeNames(components);
}

function detectSinglePackage(rootDir: string): DetectedComponent[] {
  const hasSrc = fs.existsSync(path.join(rootDir, 'src'));
  return [{ name: 'app', pattern: hasSrc ? 'src/**' : '**' }];
}

// Re-exported for callers that already have the resolved workspace package list handy (e.g. the
// layer-suggestion step, which needs both the grouping above and per-package names for edges).
export { loadWorkspacePackages };
