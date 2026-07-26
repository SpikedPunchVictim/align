/**
 * Entrypoint resolution — the impure shell (ADR 016 §"Algorithm sketch" step 1, §"Where it
 * lives"): reads a workspace package's own `package.json` for `exports`/`types`/`main` (in that
 * priority order — `exports` wins outright if present, even if none of its conditions resolve),
 * remaps a declared path that points at built output back to its pre-build source (extending the
 * same dist -> src substrate `resolveWorkspaceSpecifier` already uses for arbitrary cross-package
 * specifiers, ADR 004, rather than duplicating it), and falls back to `workspace.ts`'s own
 * filename-convention candidate list (`OWN_ENTRY_CANDIDATES`) only when nothing declared resolves.
 * Lives beside `workspace.ts`, not inside it — same file-per-concern boundary the package already
 * keeps between `workspace.ts` (package inventory + specifier resolution) and `manifest.ts`
 * (dependency fields).
 *
 * Produces `PackageEntrypoint[]` — more than one when a package declares subpath exports
 * (langchain's `./output_parsers`, ADR 016's regression case), since a package legitimately has
 * more than one public surface.
 *
 * The condition-priority list and dist-remap heuristics below (build-output prefixes, bundler
 * infix stripping, the `input` condition) were exercised and measured against 9 real TS monorepos
 * in the ADR 016 falsification spike (`docs/evidence/surface-inference-spike/SPIKE_REPORT.md`
 * Round 2, `scratchpad/round2/ts_surface.js`'s `resolveEntrypoints`/`remapToSrc`) — ported here as
 * the validated algorithm, not reinvented from the ADR's prose alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toRepoRelativePath, type PackageEntrypoint } from '@spikedpunch/align-core';
import { OWN_ENTRY_CANDIDATES, type WorkspacePackage } from './workspace.js';

interface RawPackageJson {
  readonly exports?: unknown;
  readonly types?: unknown;
  readonly main?: unknown;
}

function readPackageJson(pkgJsonPath: string): RawPackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as RawPackageJson;
  } catch {
    return undefined; // missing/malformed: read-only survey posture, same as workspace.ts/manifest.ts
  }
}

function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

// Validated priority (SPIKE_REPORT.md (c)): 'input' (tsdown/tsup convention pointing straight at
// pre-build source — @langchain/core's exports map) ranks above everything else when present,
// since it's the most direct source pointer available and needs no dist->src remap at all. The
// ADR's own algorithm sketch names only import/require/types/default explicitly; 'input'/'node'/
// 'browser' are this spike-measured addition, folded in per the report's recommendation rather
// than left an implementation-time surprise.
const CONDITION_PRIORITY = ['input', 'types', 'import', 'node', 'default', 'require', 'browser'] as const;

function resolveConditionValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const condition of CONDITION_PRIORITY) {
      if (condition in record) {
        const resolved = resolveConditionValue(record[condition]);
        if (resolved !== undefined) return resolved;
      }
    }
    // Unrecognized condition name (custom bundler condition): fall through and try every value —
    // better to guess than to give up on a package that uses a condition name off this list.
    for (const nested of Object.values(record)) {
      const resolved = resolveConditionValue(nested);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

// Matches a built-output extension shape (including TS's compound declaration extensions) —
// deliberately NOT matching plain `.ts`/`.tsx`, since a path already ending in those is real
// source, not something to remap.
const BUILD_OUTPUT_EXTENSION_RE = /\.(d\.cts|d\.mts|d\.ts|cjs|mjs|js|jsx)$/;
const BUILD_OUTPUT_PREFIXES = ['dist/', 'lib/', 'build/', 'out/'];
// Bundler-output infix tokens between a base filename and its final extension (e.g.
// `index.cjs.js`) — stripping only the final extension would leave these in the "source" guess
// (`index.cjs.ts`, which never exists). Found and fixed in the falsification spike by hand-
// checking @backstage/cli (`main: "dist/index.cjs.js"`, real source `src/index.ts`).
const BUILD_INFIX_TOKENS = new Set(['cjs', 'esm', 'mjs', 'umd', 'min', 'd', 'node', 'browser']);

function stripBuildInfixes(basenameNoExt: string): string {
  const parts = basenameNoExt.split('.');
  while (parts.length > 1 && BUILD_INFIX_TOKENS.has(parts[parts.length - 1] as string)) parts.pop();
  return parts.join('.');
}

/** Remaps a declared manifest path (which may point at built output) back to its pre-build source
 * file. Tries the raw declared path itself first (it may already BE source, e.g. an `input`
 * condition or a repo that ships `main` pointing straight at `.ts`), then a `dist/lib/build/out`
 * -> `src` prefix swap with bundler-infix stripping and an extension swap to `.ts`/`.tsx`/
 * `/index.ts`. Returns an absolute path, or undefined if nothing on disk matches any candidate —
 * deliberately never requires the ORIGINAL declared path to exist (pre-build, `dist/` typically
 * doesn't), only one of the remapped source candidates. */
function remapToSrc(rawPath: string, pkgAbsDir: string): string | undefined {
  const stripped = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
  const candidates = new Set<string>([stripped]);
  for (const prefix of BUILD_OUTPUT_PREFIXES) {
    if (stripped.startsWith(prefix)) {
      const rest = stripped.slice(prefix.length);
      candidates.add(`src/${rest}`);
      candidates.add(rest);
    }
  }

  const expanded = new Set<string>();
  for (const candidate of candidates) {
    expanded.add(candidate); // the candidate itself may already be real source
    const extMatch = BUILD_OUTPUT_EXTENSION_RE.exec(candidate);
    if (extMatch === null) {
      expanded.add(`${candidate}.ts`);
      continue;
    }
    const withoutExt = candidate.slice(0, candidate.length - extMatch[0].length);
    const destemmed = stripBuildInfixes(withoutExt);
    expanded.add(`${destemmed}.ts`);
    expanded.add(`${destemmed}.tsx`);
    expanded.add(`${destemmed}/index.ts`);
    if (destemmed !== withoutExt) {
      expanded.add(candidate.replace(BUILD_OUTPUT_EXTENSION_RE, '.ts'));
      expanded.add(candidate.replace(BUILD_OUTPUT_EXTENSION_RE, '.tsx'));
    }
  }

  for (const candidate of expanded) {
    const abs = path.join(pkgAbsDir, ...candidate.split('/'));
    if (fileExists(abs)) return abs;
  }
  return undefined;
}

function toEntrypointFile(absPath: string, rootDir: string) {
  return toRepoRelativePath(path.relative(rootDir, absPath).split(path.sep).join('/'));
}

/** Resolves one workspace package's public entrypoint(s). Always returns at least one
 * `PackageEntrypoint` — falling all the way back to `inferred-none` (`file: null`) when nothing
 * declared or conventional resolves, never an empty array (a package always has SOME answer to
 * "what is your entrypoint," even if the answer is "unresolved"). */
export function resolvePackageEntrypoints(pkg: WorkspacePackage, rootDir: string): PackageEntrypoint[] {
  const pkgAbsDir = path.join(rootDir, ...pkg.dir.split('/').filter((s) => s.length > 0));
  const raw = readPackageJson(path.join(pkgAbsDir, 'package.json'));
  const entrypoints: PackageEntrypoint[] = [];

  const exportsField = raw?.exports;
  if (exportsField !== undefined && (typeof exportsField === 'string' || (typeof exportsField === 'object' && exportsField !== null))) {
    const exportsMap: Record<string, unknown> =
      typeof exportsField === 'string' ? { '.': exportsField } : (exportsField as Record<string, unknown>);
    for (const [conditionPath, conditionValue] of Object.entries(exportsMap)) {
      if (conditionPath === './package.json' || conditionPath.includes('*')) continue; // no single concrete file
      const rawTarget = resolveConditionValue(conditionValue);
      if (rawTarget === undefined) continue;
      const resolved = remapToSrc(rawTarget, pkgAbsDir);
      if (resolved === undefined) continue;
      entrypoints.push({
        confidence: 'declared',
        file: toEntrypointFile(resolved, rootDir),
        provenance: { source: 'package.json:exports', conditionPath },
      });
    }
  } else if (typeof raw?.types === 'string' || typeof raw?.main === 'string') {
    const manifestFields: readonly ['package.json:types' | 'package.json:main', unknown][] = [
      ['package.json:types', raw?.types],
      ['package.json:main', raw?.main],
    ];
    for (const [source, rawTarget] of manifestFields) {
      if (typeof rawTarget !== 'string') continue;
      const resolved = remapToSrc(rawTarget, pkgAbsDir);
      if (resolved !== undefined) {
        entrypoints.push({ confidence: 'declared', file: toEntrypointFile(resolved, rootDir), provenance: { source } });
        break; // types wins over main when both resolve, matching the ADR's "then main" ordering
      }
    }
  }

  if (entrypoints.length === 0) {
    const matches = OWN_ENTRY_CANDIDATES.filter((candidate) =>
      fileExists(path.join(pkgAbsDir, ...candidate.split('/'))),
    );
    if (matches.length === 1) {
      entrypoints.push({
        confidence: 'inferred-unique',
        file: toEntrypointFile(path.join(pkgAbsDir, ...(matches[0] as string).split('/')), rootDir),
        provenance: { source: 'convention', candidateCount: 1 },
      });
    } else {
      // Zero candidates -> inferred-none. More than one is modeled but unobserved across every
      // repo the falsification spike measured (SPIKE_REPORT.md Round 2, Task B: 0 ambiguous cases
      // across 572 packages) — mapped conservatively to inferred-none rather than guessing which
      // candidate wins, per the ADR's algorithm sketch.
      entrypoints.push({
        confidence: 'inferred-none',
        file: null,
        provenance: { source: 'convention', candidateCount: matches.length },
      });
    }
  }

  return entrypoints;
}
