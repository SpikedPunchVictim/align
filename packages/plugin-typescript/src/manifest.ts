/**
 * Manifest scan domain (ADR 013): the concrete pnpm/Node-ecosystem reader for `security.manifest.*`
 * rules — root + workspace `package.json` files (workspace inventory via `workspace.ts`'s
 * `loadWorkspacePackages`, reused rather than duplicated) plus `pnpm-lock.yaml`'s `importers:`
 * section for lockfile-resolved specifiers (needed so a `catalog:`-managed dependency's real
 * specifier is visible to `security.manifest.source-hygiene` — docs/adr/proposals/security-manifest-gate/manifest-security-probe/MANIFEST_PROBE_REPORT.md Rule
 * 1's documented reason for reading the lockfile at all, not just package.json). No network, no
 * `node_modules` required — same read-only, pre-install posture as `workspace.ts` (ADR 004).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  toRepoRelativePath,
  type ScanBlindSpot,
  type ManifestDependency,
  type ManifestDepField,
  type ManifestInventory,
  type ManifestRecord,
  type ManifestScanner,
  type ManifestScanOptions,
} from '@spikedpunch/align-core';
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

/** Returns the matching pattern rather than a boolean, so the blind-spot record can name the one
 * responsible (ADR 028 §3 — reasons are printed, never just counts).
 *
 * NOTE, recorded rather than fixed here: this dialect is exact-or-directory-prefix only, with no
 * `globMatch`, and therefore DIVERGES from the source walker's (`scanner.ts`). One `excludes` entry
 * can drop a package's sources while keeping its manifest, or the reverse. ADR 028 names that
 * divergence as its own out-of-scope item; this change makes the manifest domain record what it
 * skips, it does not reconcile the two dialects. */
function matchingExclude(relDir: string, excludes: readonly string[]): string | undefined {
  if (relDir === '') return undefined;
  return excludes.find((pattern) => relDir === pattern || relDir.startsWith(`${pattern}/`));
}

/**
 * ADR 028 applied to this walker (F3): the ONE read, with its failure modes told apart.
 *
 * The previous shape was `existsSync` then `readFileSync` then `JSON.parse`, each failure collapsing
 * to `undefined` — so "there is no package.json here" (sound: nothing to record) was indistinguishable
 * from "I could not read it" and "I could not parse it" (both unsound: corrupt is not absent, the
 * discipline BUG #1 established, violated here in a second walker exactly as ADR 028 predicted).
 * `existsSync` made it worse: it swallows `EACCES`, so a manifest inside an unreadable directory
 * reported as genuinely gone.
 *
 * Reading first and branching on `code` is what separates them. ENOENT is the only genuine absence;
 * everything else is a blind spot, recorded with its reason so `applyMoves` and `store.prune` route
 * the entry to "still known" instead of inferring a rename or a fix.
 */
function buildManifestRecord(
  rootDir: string,
  relDir: string,
  lockImporter: LockImporter | undefined,
  record: (path: string, reason: ScanBlindSpot['reason']) => void,
): ManifestRecord | undefined {
  const pkgJsonPath = path.join(rootDir, relDir, 'package.json');
  const relFile = relDir === '' ? 'package.json' : `${relDir}/package.json`;

  let raw: string;
  try {
    raw = fs.readFileSync(pkgJsonPath, 'utf8');
  } catch (err) {
    // ENOENT is the one sound absence: there is genuinely no manifest at this path, so an entry for
    // it really was deleted. EACCES/ENOTDIR/EISDIR/ELOOP all mean "align could not look", which is
    // the case that must never be read as deletion.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      record(relFile, { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) });
    }
    return undefined;
  }

  let pkg: RawPackageJson;
  try {
    pkg = JSON.parse(raw) as RawPackageJson;
  } catch (err) {
    // Corrupt, not absent. The file is right there and the user can fix it; treating its entries as
    // fixed would delete consent records over a typo in a JSON file.
    record(relFile, { kind: 'unparseable', error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }

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

  return { file: toRepoRelativePath(relFile), raw, dependencies };
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
  const blindSpots: ScanBlindSpot[] = [];
  const record = (relPath: string, reason: ScanBlindSpot['reason']): void => {
    blindSpots.push({ path: toRepoRelativePath(relPath), reason });
  };

  const rootRecord = buildManifestRecord(rootDir, '', lock?.importers?.['.'], record);
  if (rootRecord !== undefined) manifests.push(rootRecord);

  for (const pkg of loadWorkspacePackages(rootDir, record)) {
    const relDir = pkg.dir.endsWith('/') ? pkg.dir.slice(0, -1) : pkg.dir;
    const pattern = matchingExclude(relDir, excludes);
    if (pattern !== undefined) {
      // Recorded against the DIRECTORY, not the manifest path: at-or-under containment then covers
      // the member's `package.json` and anything else under it, matching how the source walker
      // records an excluded directory.
      record(relDir, { kind: 'excluded', pattern });
      continue;
    }
    const memberRecord = buildManifestRecord(rootDir, relDir, lock?.importers?.[relDir], record);
    if (memberRecord !== undefined) manifests.push(memberRecord);
  }

  blindSpots.sort((a, b) => a.path.localeCompare(b.path));
  return { manifests, lockfilePresent: lock !== undefined, blindSpots };
}

/** `@spikedpunch/align-core`'s `ManifestScanner` injection seam, concretely implemented for the pnpm/Node
 * ecosystem — wired in at the CLI composition root exactly like `TypeScriptPlugin`
 * (`packages/cli/src/composition-root.ts`), never imported by `@spikedpunch/align-core` directly. */
export class NodeManifestScanner implements ManifestScanner {
  scan(options: ManifestScanOptions): ManifestInventory {
    return scanManifests(options.rootDir, options.excludes);
  }
}
