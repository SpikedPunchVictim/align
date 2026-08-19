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
// The source walker's own directory-exclude matcher, IMPORTED rather than reimplemented (task #11).
// This domain used to carry its own exact-or-directory-prefix dialect with no `globMatch` and no
// `/**` handling, so `excludes: ['packages/*']` hid a package's sources while leaving its manifest
// in the inventory — one config entry meaning two different things depending on which walker read
// it. BUG #4 is the precedent: a second, independent glob implementation diverged from core's three
// separate ways before it was deleted. One matcher, so the two domains cannot drift apart again.
import { matchingExcludePatternForDirectory } from './scanner.js';

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

/**
 * Task #11. `lockfilePresent: false` used to mean three different things — no lockfile, a lockfile
 * align could not read, and a lockfile it could not parse — and only the first is sound. The other
 * two are BUG #1's corrupt-≠-absent discipline, and they are not merely cosmetic here: every
 * `catalog:`-managed dependency falls back to its raw package.json text when the lockfile is
 * unavailable, so `security.manifest.source-hygiene` evaluates a different specifier than the one
 * that actually ships. A wrong answer, reported as a clean one.
 *
 * Still returns `undefined` in all three cases — the scan proceeds read-only rather than crashing,
 * which is the right posture — but the last two now say so.
 */
function readLockfile(rootDir: string, record: (path: string, reason: ScanBlindSpot['reason']) => void): PnpmLockfile | undefined {
  const lockPath = path.join(rootDir, 'pnpm-lock.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    // ENOENT is sound and common: a pre-install checkout, or a repo on another package manager.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      record('pnpm-lock.yaml', { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) });
    }
    return undefined;
  }
  try {
    const parsed: unknown = parseYaml(raw);
    // The same "it parsed" ≠ "it is the thing" gap as `manifestShapeError` below (LEDGER D039), and
    // it matters here for the reason this function's header already states: `lockfilePresent` must
    // distinguish three states, and an empty or comment-only `pnpm-lock.yaml` parses to `null`,
    // which would have been reported as a lockfile align successfully read. It is not a crash —
    // every read below is optional-chained — but it is the invariant this function exists to hold.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      record('pnpm-lock.yaml', { kind: 'unparseable', error: 'expected a mapping at the top level of pnpm-lock.yaml' });
      return undefined;
    }
    return parsed as PnpmLockfile;
  } catch (err) {
    record('pnpm-lock.yaml', { kind: 'unparseable', error: err instanceof Error ? err.message : String(err) });
    return undefined;
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

/** A plain, non-null, non-array object — the only shape either a manifest or a dependency map can
 * legally have. `typeof null === 'object'` and arrays are objects, so both need saying explicitly;
 * the array case is the one that produced a SILENT wrong answer rather than a crash. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates what `JSON.parse` never promised (LEDGER D039).
 *
 * `JSON.parse` succeeding means the bytes were JSON, not that they were a manifest, and this walker
 * used to read `pkg[field]` and `Object.entries(declared)` outside the `try` on that assumption.
 * Three shapes threw a raw `TypeError` — `"dependencies": null`, the same for the other two fields,
 * and a top-level `null` — which `orchestrator.ts` turns into an ERRORED SECURITY GATE for the whole
 * repository, with a message naming no file and `blindSpots: []` discarding everything the walk had
 * already recorded.
 *
 * The shape that did NOT throw was worse. `"dependencies": "oops"` reached `Object.entries` of a
 * string, which yields its characters, so align invented four dependencies named `0`,`1`,`2`,`3` and
 * evaluated `security.manifest.*` rules against them; `"dependencies": []` yielded zero and reported
 * a package that declares nothing. A wrong answer at exit 0 outranks a crash in this project.
 *
 * Returns the reason as prose rather than throwing, so the caller records it exactly like a JSON
 * syntax error: corrupt, not absent. That routing is what keeps `prune` from deleting the entries
 * under an unreadable manifest as "fixed".
 */
function manifestShapeError(parsed: unknown): string | undefined {
  if (!isPlainObject(parsed)) {
    return `expected an object at the top level, found ${Array.isArray(parsed) ? 'an array' : String(parsed === null ? 'null' : typeof parsed)}`;
  }
  for (const field of DEP_FIELDS) {
    const declared = parsed[field];
    if (declared === undefined) continue;
    if (!isPlainObject(declared)) {
      return `"${field}" must be an object mapping package names to version specifiers, found ${Array.isArray(declared) ? 'an array' : String(declared === null ? 'null' : typeof declared)}`;
    }
    for (const [name, specifier] of Object.entries(declared)) {
      if (typeof specifier !== 'string') {
        return `"${field}"."${name}" must be a version specifier string, found ${String(specifier === null ? 'null' : typeof specifier)}`;
      }
    }
  }
  return undefined;
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
    const parsed: unknown = JSON.parse(raw);
    // INSIDE the try, with the parse (LEDGER D039). "It was JSON" and "it was a manifest" are two
    // different facts, and reading the second off the first is what let a `TypeError` escape this
    // function into the orchestrator's gate-level catch.
    const shapeError = manifestShapeError(parsed);
    if (shapeError !== undefined) {
      record(relFile, { kind: 'unparseable', error: shapeError });
      return undefined;
    }
    pkg = parsed as RawPackageJson;
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
  const manifests: ManifestRecord[] = [];
  const blindSpots: ScanBlindSpot[] = [];
  const record = (relPath: string, reason: ScanBlindSpot['reason']): void => {
    blindSpots.push({ path: toRepoRelativePath(relPath), reason });
  };

  // Declared before the lockfile read, not after: the lockfile is the first thing this scan can
  // fail to look at, and it used to fail silently.
  const lock = readLockfile(rootDir, record);

  const rootRecord = buildManifestRecord(rootDir, '', lock?.importers?.['.'], record);
  if (rootRecord !== undefined) manifests.push(rootRecord);

  for (const pkg of loadWorkspacePackages(rootDir, record)) {
    const relDir = pkg.dir.endsWith('/') ? pkg.dir.slice(0, -1) : pkg.dir;
    // TWO tests, because the two domains name paths differently and one test alone leaves a gap
    // that adversarial review found in the first version of this fix. The source walker matches
    // FILE paths; this walker enumerates member DIRECTORIES. A pattern like `packages/vendor/*`
    // matches `packages/vendor/package.json` but not `packages/vendor`, so testing only the
    // directory excluded a package's sources while keeping its manifest — the exact "one entry,
    // two meanings" divergence this shared matcher exists to remove.
    const relManifest = `${relDir}/package.json`;
    const dirPattern = matchingExcludePatternForDirectory(relDir, excludes);
    const pattern = dirPattern ?? matchingExcludePatternForDirectory(relManifest, excludes);
    if (pattern !== undefined) {
      // The DIRECTORY when the directory matched — at-or-under containment then covers the
      // member's `package.json` and everything beside it, matching how the source walker records an
      // excluded directory. Only the MANIFEST when only the manifest matched: claiming the whole
      // directory there would retain baseline entries for files the pattern never mentioned.
      record(dirPattern !== undefined ? relDir : relManifest, { kind: 'excluded', pattern });
      continue;
    }
    const memberRecord = buildManifestRecord(rootDir, relDir, lock?.importers?.[relDir], record);
    if (memberRecord !== undefined) manifests.push(memberRecord);
  }

  // Collapse duplicates by (path, kind). Two readers can legitimately fail on the SAME file for the
  // same reason — a malformed root `package.json` is both "no workspace globs" and "no root
  // manifest" — and the record has no way to say which is which, so reporting it twice is noise
  // rather than information. Distinct kinds on one path are kept: those ARE different facts.
  const seen = new Set<string>();
  const deduped = blindSpots.filter((spot) => {
    const key = `${spot.path}\u0000${spot.reason.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.path.localeCompare(b.path));
  return { manifests, lockfilePresent: lock !== undefined, blindSpots: deduped };
}

/** `@spikedpunch/align-core`'s `ManifestScanner` injection seam, concretely implemented for the pnpm/Node
 * ecosystem — wired in at the CLI composition root exactly like `TypeScriptPlugin`
 * (`packages/cli/src/composition-root.ts`), never imported by `@spikedpunch/align-core` directly. */
export class NodeManifestScanner implements ManifestScanner {
  scan(options: ManifestScanOptions): ManifestInventory {
    return scanManifests(options.rootDir, options.excludes);
  }
}
