/**
 * Manifest scan domain (ADR 013): the concrete pnpm/Node-ecosystem reader for `security.manifest.*`
 * rules — root + workspace `package.json` files (workspace inventory via `workspace.ts`'s
 * `loadWorkspacePackages`, reused rather than duplicated) plus `pnpm-lock.yaml`'s `importers:`
 * section for lockfile-resolved specifiers (needed so a `catalog:`-managed dependency's real
 * specifier is visible to `security.manifest.source-hygiene` — spike/MANIFEST_PROBE_REPORT.md Rule
 * 1's documented reason for reading the lockfile at all, not just package.json). No network, no
 * `node_modules` required — same read-only, pre-install posture as `workspace.ts` (ADR 004).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  toRepoRelativePath,
  type ManifestDependency,
  type ManifestDepField,
  type ManifestInventory,
  type ManifestRecord,
  type ManifestScanner,
  type ManifestScanOptions,
} from '@align/core';
import { loadWorkspacePackages } from './workspace.js';

const DEP_FIELDS: readonly ManifestDepField[] = ['dependencies', 'devDependencies', 'optionalDependencies'];

interface RawPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface LockImporterDep {
  specifier: string;
}

/** Keyed identically to `ManifestDepField` — pnpm-lock.yaml's `importers:` entries use the same
 * three field names as package.json. */
type LockImporter = Partial<Record<ManifestDepField, Record<string, LockImporterDep>>>;

interface PnpmLockfile {
  readonly importers?: Record<string, LockImporter>;
}

function readJson<T>(absPath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8')) as T;
  } catch {
    return undefined; // malformed/unreadable: skip this one file, not the whole scan
  }
}

function readLockfile(rootDir: string): PnpmLockfile | undefined {
  const lockPath = path.join(rootDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) return undefined;
  try {
    return parseYaml(fs.readFileSync(lockPath, 'utf8')) as PnpmLockfile;
  } catch {
    return undefined; // malformed lockfile: read-only survey posture, don't crash the scan
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Best-effort raw-text line lookup for a dependency key — a deliberately boring heuristic (first
 * `"<name>":` match in the file), not a JSON-position parser; documented v1 limitation, same
 * posture as `workspace.ts`'s `resolveWorkspaceSpecifier` (CODING_BEST_PRACTICES.md §3). Good
 * enough for `Violation.range`/`snippet` — a wrong line within the same file is a minor cosmetic
 * miss, never a wrong fingerprint (fingerprints never use line numbers, ADR 006/013). */
function findDependencyLine(raw: string, depName: string): number | undefined {
  const re = new RegExp(`^\\s*"${escapeRegExp(depName)}"\\s*:`);
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i] ?? '')) return i + 1;
  }
  return undefined;
}

function isExcluded(relDir: string, excludes: readonly string[]): boolean {
  if (relDir === '') return false;
  return excludes.some((pattern) => relDir === pattern || relDir.startsWith(`${pattern}/`));
}

function buildManifestRecord(rootDir: string, relDir: string, lockImporter: LockImporter | undefined): ManifestRecord | undefined {
  const pkgJsonPath = path.join(rootDir, relDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return undefined;

  let raw: string;
  try {
    raw = fs.readFileSync(pkgJsonPath, 'utf8');
  } catch {
    return undefined;
  }
  const pkg = readJson<RawPackageJson>(pkgJsonPath);
  if (pkg === undefined) return undefined;

  const dependencies: ManifestDependency[] = [];
  for (const field of DEP_FIELDS) {
    const declared = pkg[field];
    if (declared === undefined) continue;
    const lockGroup = lockImporter?.[field];
    for (const [name, rawSpecifier] of Object.entries(declared)) {
      const specifier = lockGroup?.[name]?.specifier ?? rawSpecifier;
      const line = findDependencyLine(raw, name);
      dependencies.push({ name, specifier, field, ...(line === undefined ? {} : { line }) });
    }
  }

  const filePath = relDir === '' ? 'package.json' : `${relDir}/package.json`;
  return { file: toRepoRelativePath(filePath), raw, dependencies };
}

/** Scans the manifest domain for one repo: the root `package.json` (always, even though it's
 * never itself a `loadWorkspacePackages` entry — that function only enumerates
 * `pnpm-workspace.yaml` glob members) plus every workspace member's `package.json`, each
 * dependency's specifier resolved through `pnpm-lock.yaml`'s matching `importers:` entry when a
 * lockfile is present (root importer key is `.`; member keys are their repo-relative dir with no
 * trailing slash). */
export function scanManifests(rootDir: string, excludes: readonly string[] = []): ManifestInventory {
  const lock = readLockfile(rootDir);
  const manifests: ManifestRecord[] = [];

  const rootRecord = buildManifestRecord(rootDir, '', lock?.importers?.['.']);
  if (rootRecord !== undefined) manifests.push(rootRecord);

  for (const pkg of loadWorkspacePackages(rootDir)) {
    const relDir = pkg.dir.endsWith('/') ? pkg.dir.slice(0, -1) : pkg.dir;
    if (isExcluded(relDir, excludes)) continue;
    const record = buildManifestRecord(rootDir, relDir, lock?.importers?.[relDir]);
    if (record !== undefined) manifests.push(record);
  }

  return { manifests, lockfilePresent: lock !== undefined };
}

/** `@align/core`'s `ManifestScanner` injection seam, concretely implemented for the pnpm/Node
 * ecosystem — wired in at the CLI composition root exactly like `TypeScriptPlugin`
 * (`packages/cli/src/composition-root.ts`), never imported by `@align/core` directly. */
export class NodeManifestScanner implements ManifestScanner {
  scan(options: ManifestScanOptions): ManifestInventory {
    return scanManifests(options.rootDir, options.excludes);
  }
}
