/**
 * `align doctor` advisory scans (Stage 2) that need TS-specific filesystem knowledge — tsconfig
 * `paths` parsing and workspace-package inventory — so they live in the TypeScript plugin
 * alongside the scanner/resolver that already own that knowledge, rather than duplicating tsconfig
 * parsing in the CLI. Both functions are read-only surveys: malformed input is skipped, never
 * thrown, matching the scanner's "read-only survey posture" (ADR 003/004).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { loadWorkspacePackages } from './workspace.js';

const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.build',
  '.history',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'out',
]);

function toSlash(p: string): string {
  return p.split(path.sep).join('/');
}

/** Same exclude vocabulary as the scanner's `excludes` option (literal prefixes and simple
 * `*`/`**` globs) — a repo's own align.config.ts excludes (e.g. read-only vendored trees, fixture
 * directories with intentionally-broken configs) must apply here too, or `align doctor` reports
 * noise the repo owner already told align to ignore. */
function isExcluded(relPath: string, excludes: readonly string[]): boolean {
  if (relPath === '') return false;
  return excludes.some((pattern) => relPath === pattern || relPath.startsWith(`${pattern}/`) || globLikeMatch(pattern, relPath));
}

function globLikeMatch(pattern: string, filePath: string): boolean {
  if (!pattern.includes('*')) return false;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

function walkDirs(rootDir: string, excludes: readonly string[], visit: (absDir: string) => void): void {
  const inner = (absDir: string): void => {
    const relDir = toSlash(path.relative(rootDir, absDir));
    if (isExcluded(relDir, excludes)) return;
    visit(absDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !EXCLUDED_DIR_NAMES.has(entry.name) && !entry.name.startsWith('.')) {
        inner(path.join(absDir, entry.name));
      }
    }
  };
  inner(rootDir);
}

export interface DeadAlias {
  readonly tsconfig: string; // repo-relative path to the tsconfig.json declaring the alias
  readonly alias: string; // e.g. '@kluster/shared/*'
  readonly target: string; // raw paths value, e.g. './shared/*'
}

/**
 * tsconfig `paths` entries whose target doesn't resolve to anything on disk (spike finding:
 * `@kluster/shared/*` -> a nonexistent directory — trusting tsconfig paths uncritically would
 * have turned it into a phantom component per ADR 003). Walks every tsconfig.json in the repo
 * (not just ones already visited by a check/scan), since a dead alias in an otherwise-unused
 * tsconfig is exactly the kind of drift `align doctor` exists to surface.
 */
export function findDeadAliases(rootDir: string, excludes: readonly string[] = []): DeadAlias[] {
  const dead: DeadAlias[] = [];

  walkDirs(rootDir, excludes, (absDir) => {
    const tsconfigPath = path.join(absDir, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) return;

    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.config === undefined) return;
    // Same trap as TsconfigResolver: strip include/files before parseJsonConfigFileContent.
    const config = read.config as Record<string, unknown>;
    delete config['include'];
    delete config['exclude'];
    config['files'] = [];

    let parsed: ts.ParsedCommandLine;
    try {
      parsed = ts.parseJsonConfigFileContent(config, ts.sys, absDir);
    } catch {
      return;
    }

    const paths = parsed.options.paths;
    if (paths === undefined) return;
    const baseUrl = parsed.options.baseUrl ?? absDir;

    for (const [alias, targets] of Object.entries(paths)) {
      for (const target of targets) {
        if (!targetExists(baseUrl, target)) {
          dead.push({ tsconfig: toSlash(path.relative(rootDir, tsconfigPath)), alias, target });
        }
      }
    }
  });

  return dead;
}

function targetExists(baseUrl: string, target: string): boolean {
  const withoutGlob = target.endsWith('*') ? target.slice(0, -1) : target;
  const resolved = path.resolve(baseUrl, withoutGlob);
  if (fs.existsSync(resolved)) return true;
  return ['.ts', '.tsx', '.d.ts', '.js', '.mts', '.cts'].some((ext) => fs.existsSync(`${resolved}${ext}`));
}

export interface OrphanedPackage {
  readonly dir: string; // repo-relative, trailing slash
  readonly name: string;
}

/**
 * Packages on disk (a directory with a `package.json`) that no `pnpm-workspace.yaml` glob covers
 * (spike finding: kluster had 13 workspace-orphaned `@fold/*` packages). Returns `[]` when there's
 * no `pnpm-workspace.yaml` at all — the "orphaned" concept only applies to declared pnpm
 * workspaces, not every repo with a package.json.
 */
export function findOrphanedPackages(rootDir: string, excludes: readonly string[] = []): OrphanedPackage[] {
  const covered = new Set(loadWorkspacePackages(rootDir).map((p) => p.dir));
  if (!fs.existsSync(path.join(rootDir, 'pnpm-workspace.yaml'))) return [];

  const orphaned: OrphanedPackage[] = [];
  walkDirs(rootDir, excludes, (absDir) => {
    if (absDir === rootDir) return; // the monorepo root manifest is not itself a workspace member
    const pkgJsonPath = path.join(absDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return;

    const relDir = `${toSlash(path.relative(rootDir, absDir))}/`;
    if (covered.has(relDir)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        orphaned.push({ dir: relDir, name: pkg.name });
      }
    } catch {
      // malformed package.json: skip this one, not the whole scan
    }
  });

  return orphaned;
}
