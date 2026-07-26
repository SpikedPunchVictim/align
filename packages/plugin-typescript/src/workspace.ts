/**
 * pnpm-workspace.yaml package inventory (ADR 004): resolves workspace package names to their
 * source directories without requiring `node_modules` to exist — the mechanism that makes
 * `pnpm install` a non-prerequisite for seeing a repo's architecture. Doubles as the
 * package-entry -> source mapping (cross-package imports would otherwise resolve to
 * `dist/**\/*.d.ts`, which are not scanned nodes).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string; // repo-relative, trailing slash, forward slashes
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];

/**
 * The workspace glob-pattern list, read from whichever package manager's declaration exists:
 * pnpm's `pnpm-workspace.yaml` `packages:` (authoritative for pnpm — package.json `workspaces` is
 * ignored by pnpm, so it wins when both are present), or npm/yarn/bun's `package.json`
 * `workspaces` field (array form, or yarn-classic's `{ packages: [...] }` object form). The glob
 * vocabulary is identical across all four, so `expandPattern` consumes the result unchanged. Deno
 * (`deno.json`'s `workspace` field) is intentionally not read here — see the PM-support notes.
 * Read-only survey posture: a malformed file yields `[]`, never a thrown scan.
 */
export function readWorkspaceGlobs(rootDir: string): string[] {
  const pnpmWsPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWsPath)) {
    try {
      const doc = parseYaml(fs.readFileSync(pnpmWsPath, 'utf8')) as { packages?: unknown } | undefined;
      const patterns = asStringArray(doc?.packages);
      if (patterns.length > 0) return patterns;
    } catch {
      // fall through to package.json — a malformed pnpm-workspace.yaml shouldn't hide a workspaces field
    }
  }

  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const ws = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown }).workspaces;
      if (Array.isArray(ws)) return asStringArray(ws);
      if (ws !== null && typeof ws === 'object') return asStringArray((ws as { packages?: unknown }).packages);
    } catch {
      // malformed package.json: read-only survey posture
    }
  }

  return [];
}

export function loadWorkspacePackages(rootDir: string): WorkspacePackage[] {
  const patterns = readWorkspaceGlobs(rootDir);
  if (patterns.length === 0) return [];

  const dirs = new Set<string>();
  for (const pattern of patterns) {
    for (const dir of expandPattern(rootDir, pattern)) dirs.add(dir);
  }

  const packages: WorkspacePackage[] = [];
  for (const abs of dirs) {
    const pkgJsonPath = path.join(abs, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        const rel = path.relative(rootDir, abs).split(path.sep).join('/');
        packages.push({ name: pkg.name, dir: rel.endsWith('/') ? rel : `${rel}/` });
      }
    } catch {
      // malformed package.json: skip this one package, not the whole scan
    }
  }
  return packages;
}

/** Expands one pnpm-workspace.yaml glob pattern to absolute directories that contain a
 * package.json. Supports the pattern vocabulary pnpm-workspace.yaml actually uses: literal
 * segments, a single trailing/interior `*` (one directory level), and a trailing `**` (recursive
 * — any package.json anywhere under the prefix). */
function expandPattern(rootDir: string, pattern: string): string[] {
  const normalized = pattern.split('\\').join('/');
  if (normalized.endsWith('/**') || normalized === '**') {
    const prefix = normalized === '**' ? '' : normalized.slice(0, -'/**'.length);
    const base = path.join(rootDir, prefix);
    return collectPackageDirsRecursive(base);
  }

  const segments = normalized.split('/').filter((s) => s.length > 0);
  let currentDirs = [rootDir];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of currentDirs) {
      if (segment === '*') {
        for (const entry of safeReaddir(dir)) {
          if (entry.isDirectory()) next.push(path.join(dir, entry.name));
        }
      } else {
        const candidate = path.join(dir, segment);
        if (isDirectory(candidate)) next.push(candidate);
      }
    }
    currentDirs = next;
  }
  return currentDirs;
}

function collectPackageDirsRecursive(base: string): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    if (!isDirectory(dir)) return;
    if (fs.existsSync(path.join(dir, 'package.json'))) results.push(dir);
    for (const entry of safeReaddir(dir)) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        visit(path.join(dir, entry.name));
      }
    }
  };
  visit(base);
  return results;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A package's own-root (no subpath) entry-file candidates, relative to its directory, tried in
 * this order. Shared between `resolveWorkspaceSpecifier`'s own-package branch below and
 * `entrypoint.ts`'s convention-fallback resolver (ADR 016) — one list, not two copies that could
 * silently drift apart (CODING_BEST_PRACTICES.md §26, "DRY the things that must change together"). */
export const OWN_ENTRY_CANDIDATES: readonly string[] = [
  'src/index.ts',
  'src/index.tsx',
  'index.ts',
  'index.tsx',
  'src/index.js',
  'index.js',
];

/** Given a bare import specifier and the workspace inventory, finds the owning package and its
 * source-entry file (package-entry -> source mapping, ADR 004). Tries common TS monorepo entry
 * conventions rather than a full package.json `exports` map resolver — a deliberately boring
 * heuristic (CODING_BEST_PRACTICES.md §3), documented as a v1 limitation. */
export function resolveWorkspaceSpecifier(
  specifier: string,
  packages: readonly WorkspacePackage[],
  rootDir: string,
): string | undefined {
  const match = packages.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
  if (match === undefined) return undefined;

  const subpath = specifier === match.name ? '' : specifier.slice(match.name.length + 1);
  const pkgAbsDir = path.join(rootDir, match.dir);
  const candidates =
    subpath === ''
      ? OWN_ENTRY_CANDIDATES.map((c) => path.join(pkgAbsDir, ...c.split('/')))
      : [
          `${path.join(pkgAbsDir, subpath)}.ts`,
          `${path.join(pkgAbsDir, subpath)}.tsx`,
          path.join(pkgAbsDir, subpath, 'index.ts'),
          `${path.join(pkgAbsDir, 'src', subpath)}.ts`,
          path.join(pkgAbsDir, 'src', subpath, 'index.ts'),
          `${path.join(pkgAbsDir, subpath)}.js`,
        ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}
