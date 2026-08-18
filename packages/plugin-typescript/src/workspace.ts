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
import type { ScanBlindSpot } from '@spikedpunch/align-core';

export interface WorkspacePackage {
  readonly name: string;
  /**
   * Repo-relative, forward slashes, trailing slash — **except** for a package rooted at the repo
   * root itself (`workspaces: ["."]` / `[""]` / `["./"]`, or pnpm `packages: ["**"]` when the
   * root has its own `package.json`), which is the one case with no relative path segment to put
   * a slash after. That package's `dir` is `''`, not `'/'` — `matchesSelector`
   * (`core/src/components/registry.ts`) relies on `file.startsWith(dir)`, and `startsWith('')` is
   * true for every file (the correct "rooted at the repo root" semantics), whereas `'/'` matches
   * no repo-relative path and silently classifies zero files.
   */
  readonly dir: string;
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];

export type BlindSpotSink = (path: string, reason: ScanBlindSpot['reason']) => void;

/**
 * Reads one workspace-declaration file, telling its three failure modes apart (task #11, ADR 028's
 * discipline applied one layer up from `loadWorkspacePackages`).
 *
 * ENOENT returns `undefined` and records nothing: no `pnpm-workspace.yaml` is the ordinary
 * single-package repo, and no `lerna.json` is nearly every repo — recording those would put an
 * advisory on almost everything align sees, which is the fastest way to teach a user to ignore
 * advisories. Every OTHER read error means align could not look, which is never the same fact.
 */
function readDeclaration(absPath: string, relPath: string, record: BlindSpotSink | undefined): string | undefined {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      record?.(relPath, { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) });
    }
    return undefined;
  }
}

/**
 * The workspace glob-pattern list, read from whichever package manager's declaration exists:
 * pnpm's `pnpm-workspace.yaml` `packages:` (authoritative for pnpm — package.json `workspaces` is
 * ignored by pnpm, so it wins when both are present), or npm/yarn/bun's `package.json`
 * `workspaces` field (array form, or yarn-classic's `{ packages: [...] }` object form), or, as a
 * last fallback, lerna's `lerna.json` `packages` field — a lerna monorepo (e.g. NestJS) declares
 * its members there and often ships no `workspaces` field at all, so without this its whole
 * `packages/*` tree collapses to a single `app` component. The glob vocabulary is identical across
 * all of them, so `expandPattern` consumes the result unchanged. Deno (`deno.json`'s `workspace`
 * field) is intentionally not read here — see the PM-support notes. Read-only survey posture: a
 * malformed file yields `[]`, never a thrown scan.
 */
/**
 * `record` (task #11): the sink `loadWorkspacePackages` already threads for per-member failures,
 * extended to the layer that decides whether that loop runs at ALL.
 *
 * This was the gap. `loadWorkspacePackages` reads each member manifest correctly and records what
 * it cannot read — but it opens with `if (patterns.length === 0) return []`, so a
 * `pnpm-workspace.yaml` that could not be read or parsed produced an empty member set, an empty
 * inventory, and not one blind spot. Measured before the fix: a two-package workspace with one
 * malformed character in `pnpm-workspace.yaml` scanned the root manifest only and reported
 * `blindSpots: []`. Shape S-09 — the inner loop was fixed, the guard deciding whether the loop runs
 * was not.
 *
 * **These records report; they do not drive containment, and that is deliberate.** A member set
 * align could not read is a set whose paths it cannot name, so there is no precise path to record
 * against. Retention for those entries falls to ADR 028 mechanism 2 (the file-existence probe): a
 * member's `package.json` is still on disk and unobserved, so it is retained already. Recording the
 * repo root instead, to force at-or-under containment, would retain every entry in the repository
 * over one malformed YAML file — shape S-04, safe and useless.
 *
 * The sink stays OPTIONAL, extending the exemption argued on `loadWorkspacePackages` below rather
 * than inventing a new one: of the three callers, only the manifest path (`scanManifests`) feeds a
 * destructive inference, and `doctor`/`init` infer nothing from a missing member.
 */
export function readWorkspaceGlobs(rootDir: string, record?: BlindSpotSink): string[] {
  const pnpmWs = readDeclaration(path.join(rootDir, 'pnpm-workspace.yaml'), 'pnpm-workspace.yaml', record);
  if (pnpmWs !== undefined) {
    try {
      const doc = parseYaml(pnpmWs) as { packages?: unknown } | undefined;
      const patterns = asStringArray(doc?.packages);
      if (patterns.length > 0) return patterns;
    } catch (err) {
      // Fall through to package.json — a malformed pnpm-workspace.yaml shouldn't HIDE a workspaces
      // field — but say so on the way past. Silently falling through is how a repo ends up scanned
      // by the wrong declaration with nobody told.
      record?.('pnpm-workspace.yaml', { kind: 'unparseable', error: err instanceof Error ? err.message : String(err) });
    }
  }

  const pkgRaw = readDeclaration(path.join(rootDir, 'package.json'), 'package.json', record);
  if (pkgRaw !== undefined) {
    try {
      const ws = (JSON.parse(pkgRaw) as { workspaces?: unknown }).workspaces;
      if (Array.isArray(ws)) return asStringArray(ws);
      if (ws !== null && typeof ws === 'object') return asStringArray((ws as { packages?: unknown }).packages);
    } catch (err) {
      // `buildManifestRecord` records this same file, with this same reason kind, for its own read.
      // The two losses are genuinely different (no workspace globs vs. no root manifest) but the
      // record cannot express the difference — same path, same kind — so `scanManifests` collapses
      // them and the user is told once. Recorded here anyway rather than skipped: this reader has
      // three callers, and the other two do not run `buildManifestRecord` at all.
      record?.('package.json', { kind: 'unparseable', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // lerna.json — reached only when no PM workspace declaration won above (a repo using both a real
  // `workspaces` field and lerna delegates globbing to the PM, so that wins). Lerna defaults an
  // omitted `packages` to `['packages/*']`, so an existing lerna.json always yields a usable glob.
  const lernaRaw = readDeclaration(path.join(rootDir, 'lerna.json'), 'lerna.json', record);
  if (lernaRaw !== undefined) {
    try {
      const patterns = asStringArray((JSON.parse(lernaRaw) as { packages?: unknown }).packages);
      return patterns.length > 0 ? patterns : ['packages/*'];
    } catch (err) {
      record?.('lerna.json', { kind: 'unparseable', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return [];
}

/**
 * `record` (ADR 028 F3, optional): a sink for paths this function declines to turn into a workspace
 * member. Optional — and that IS the anti-pattern ADR 027/028 warn about, so the exemption is
 * argued rather than assumed. Those ADRs make a safety PARAMETER required because omitting it
 * silently disables a protection at a production call site. This is a reporting sink, and only one
 * of the four callers feeds a destructive inference from the result: `scanManifests`, whose
 * inventory becomes the security gate's `knownFiles` and therefore decides move-transfer. The other
 * three (`scanner.ts`'s classification index, `doctor.ts`'s coverage report, `init`'s component
 * detection) infer nothing destructive from a missing member, and the source walk records their
 * scan-scope facts separately. Making it required would churn four call sites and a dozen tests to
 * express "I do not need this", which is what `undefined` already says.
 */
export function loadWorkspacePackages(
  rootDir: string,
  record?: (path: string, reason: ScanBlindSpot['reason']) => void,
): WorkspacePackage[] {
  const patterns = readWorkspaceGlobs(rootDir, record);
  if (patterns.length === 0) return [];

  const dirs = new Set<string>();
  for (const pattern of patterns) {
    for (const dir of expandPattern(rootDir, pattern, record)) dirs.add(dir);
  }

  const packages: WorkspacePackage[] = [];
  for (const abs of dirs) {
    const pkgJsonPath = path.join(abs, 'package.json');
    const relJson = path.relative(rootDir, pkgJsonPath).split(path.sep).join('/');
    // Read first, branch on the error, exactly as `manifest.ts`'s `buildManifestRecord` does. The
    // previous `existsSync` guard hid the case that mattered: it swallows `EACCES`, so a member
    // whose DIRECTORY is unreadable reported as "no package.json here" and the member vanished with
    // no record anywhere. That was the last leg of ADR 028's F3 window — the manifest never reached
    // the inventory, no blind spot covered it, and the existence probe also reads absent through an
    // unreadable directory, so the entry went to the content-fingerprint match.
    let raw: string;
    try {
      raw = fs.readFileSync(pkgJsonPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        record?.(relJson, { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) });
      }
      continue; // ENOENT: genuinely not a package directory, nothing to record
    }
    try {
      const pkg = JSON.parse(raw) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        const rel = path.relative(rootDir, abs).split(path.sep).join('/');
        // `rel === ''` means `abs === rootDir` — the package IS the repo root. Leave `dir` as
        // `''` rather than appending a trailing slash (which would produce `'/'`, matching no
        // repo-relative file — see the `WorkspacePackage.dir` doc comment above).
        const dir = rel === '' ? '' : rel.endsWith('/') ? rel : `${rel}/`;
        packages.push({ name: pkg.name, dir });
      } else {
        // A `package.json` align could read and parse, but which declares no usable `name`. It was
        // the last silent exit in this walker after the task #11 sweep, and it is not benign: the
        // member never enters `ManifestInventory`, so every `security.manifest.*` rule evaluates
        // vacuously green for that package, and its baseline entries fall through to ADR 028
        // mechanism 2 — where the user is told "still on disk, but this scan produced no result for
        // it", i.e. that align cannot explain its own miss. It can: the manifest has no name.
        //
        // `unparseable` rather than a new reason kind: from a consumer's point of view the file did
        // not yield the record it exists to yield, which is what that kind already means, and the
        // message says exactly which part failed.
        record?.(relJson, { kind: 'unparseable', error: 'no usable "name" field, so this package cannot be identified as a workspace member' });
      }
    } catch (err) {
      // Malformed, not absent — the corrupt-≠-absent discipline BUG #1 established. Skip this one
      // package, not the whole scan, but never silently.
      record?.(relJson, { kind: 'unparseable', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return packages;
}

/** Expands one pnpm-workspace.yaml glob pattern to absolute directories that contain a
 * package.json. Supports the pattern vocabulary pnpm-workspace.yaml actually uses: literal
 * segments, a single trailing/interior `*` (one directory level), and a trailing `**` (recursive
 * — any package.json anywhere under the prefix). */
function expandPattern(rootDir: string, pattern: string, record?: BlindSpotSink): string[] {
  const normalized = pattern.split('\\').join('/');
  if (normalized.endsWith('/**') || normalized === '**') {
    const prefix = normalized === '**' ? '' : normalized.slice(0, -'/**'.length);
    const base = path.join(rootDir, prefix);
    return collectPackageDirsRecursive(base, rootDir, record);
  }

  const segments = normalized.split('/').filter((s) => s.length > 0);
  let currentDirs = [rootDir];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of currentDirs) {
      if (segment === '*') {
        for (const entry of safeReaddir(dir, rootDir, record)) {
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

function collectPackageDirsRecursive(base: string, rootDir: string, record?: BlindSpotSink): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    if (!isDirectory(dir)) return;
    if (fs.existsSync(path.join(dir, 'package.json'))) results.push(dir);
    for (const entry of safeReaddir(dir, rootDir, record)) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        visit(path.join(dir, entry.name));
      }
    }
  };
  visit(base);
  return results;
}

/**
 * Task #11. Unlike the config-file records above, THIS one drives containment as well as reporting:
 * an unreadable directory names the affected subtree exactly, so a baseline entry beneath it is
 * retained by the blind-spot test rather than relying on the probe (which cannot see through an
 * unreadable parent either — the case `blind-spot-unreadable-retains` exists for).
 *
 * ENOENT is still silent: a glob may legitimately name a directory that does not exist.
 */
function safeReaddir(dir: string, rootDir: string, record?: BlindSpotSink): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const rel = path.relative(rootDir, dir).split(path.sep).join('/');
      record?.(rel === '' ? '.' : rel, { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) });
    }
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
