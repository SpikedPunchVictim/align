/**
 * Per-file syntactic scan-and-discard (ADR 004): parse each file with the TypeScript compiler
 * API (not ts-morph — the raw compiler API is the spike-proven implementation), extract edges,
 * discard the AST immediately. Ported from docs/adr/proposals/graph-extraction/kluster-spike/src/scanner.ts, adapted to core's `Scanner`
 * contract and extended with the asset-specifier / configurable-build-output-exclude vocabulary
 * and snippet capture (needed for `Violation.snippet`, see @spikedpunch/align-core's documented deviation).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {
  classifyFile,
  expandBraces,
  globMatch,
  toComponentName,
  toRepoRelativePath,
  validateComponents,
  type ComponentName,
  type DependencyGraph,
  type DependencyGraphEdge,
  type DependencyGraphNode,
  type EdgeKind,
  type ExternalDependencyEdge,
  type ExternalPackageNode,
  type RepoRelativePath,
  type ScanBlindSpot,
  type ScanBlindSpotReason,
  type ScanInput,
  type Scanner,
  type UncertaintyMarker,
} from '@spikedpunch/align-core';
import { extractExportedSymbols } from './exports.js';
import { TsconfigResolver } from './tsconfig-resolver.js';
import { loadWorkspacePackages, type WorkspacePackage } from './workspace.js';
import { DEFAULT_EXCLUDED_DIR_NAMES } from './scan-scope.js';

// Sentinel component for a scanned file matching no component selector — exported so `align
// doctor`'s "unmapped files" advisory (Stage 2) can identify these nodes without duplicating the
// string literal.
export const UNMAPPED_COMPONENT = toComponentName('__unmapped__');

// .mjs/.cjs/.mts/.cts added (Stage 5 infra): kluster has 43 real .mjs + 9 .cjs files invisible to
// the scanner before this change (measured against the copy under test-apps/kluster); n8n has 230
// .mjs + 6 .cjs + 9 .mts. Same lexical grammar as .ts/.js — `ts.createSourceFile` parses all of
// them identically, and TS's own module resolution already understands the extension-specific
// import/require semantics (NodeNext), so no separate parse or resolution path is needed.
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const ASSET_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.json',
  '.vue',
  '.graphql',
  '.gql',
  '.md',
  '.mdx',
  '.wasm',
  '.html',
  '.txt',
  '.yaml',
  '.yml',
]);

interface FileScanResult {
  readonly edges: DependencyGraphEdge[];
  readonly externalEdges: ExternalDependencyEdge[];
  readonly uncertain: UncertaintyMarker[];
  readonly loc: number;
  readonly exports: readonly string[];
  // First line of the file, trimmed — `DependencyGraphNode.snippet`'s source (see @spikedpunch/align-core's
  // documented deviation on that field). Cheap: `lines` is already in memory for `loc`.
  readonly snippet: string;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export class TypeScriptScanner implements Scanner {
  async scan(input: ScanInput): Promise<DependencyGraph> {
    const scannedAt = Date.now();
    // Canonicalize once and use this root everywhere below. `ts.sys.realpath` is applied to
    // *resolved* files inside TsconfigResolver (ADR 004's realpath classification fix); if the
    // root itself isn't equally canonicalized, a symlinked ancestor (e.g. macOS's /tmp -> /private/tmp)
    // makes `path.relative(rootDir, realpath(resolvedFile))` produce a bogus `../..` path, which
    // silently misclassifies same-repo edges as external — the exact false-green shape ADR 004
    // exists to prevent, just triggered by the OS temp-dir symlink instead of a pnpm one.
    const rootDir = safeRealpath(input.rootDir);
    const workspacePackages = loadWorkspacePackages(rootDir);
    const resolver = new TsconfigResolver(rootDir, workspacePackages);
    const workspaceIndex = new Map<string, RepoRelativePath>(
      workspacePackages.map((p) => [p.name, toRepoRelativePath(p.dir)]),
    );

    const excludes = [...input.excludes];
    const includeNestedCheckouts = input.includeNestedCheckouts ?? [];
    const { files, blindSpots } = walkSourceFiles(rootDir, excludes, includeNestedCheckouts);

    const nodes: DependencyGraphNode[] = [];
    const edges: DependencyGraphEdge[] = [];
    const uncertain: UncertaintyMarker[] = [];
    const externalEdges: ExternalDependencyEdge[] = [];
    // External-package retention (Stage 5 infra): externals are the majority of import specifiers
    // in a real repo (n8n measured), and the same package name repeats across thousands of import
    // sites — a shared string-intern table + node-id dedup map, scoped to one scan, bounds peak
    // heap by distinct-package count rather than edge count instead of allocating a fresh
    // `external:<name>` string (and a fresh `packageName` string out of the resolver's per-
    // directory resolution cache) per import site.
    const externalStringIntern = new Map<string, string>();
    const externalNodesById = new Map<string, ExternalPackageNode>();

    for (const absPath of files) {
      const relPath = toRepoRelativePath(path.relative(rootDir, absPath).split(path.sep).join('/'));
      const result = scanFile(absPath, rootDir, resolver, excludes, workspacePackages, externalStringIntern, externalNodesById);
      const component = classifyFile(relPath, input.components, workspaceIndex);
      nodes.push({
        file: relPath,
        component: component ?? UNMAPPED_COMPONENT,
        loc: result.loc,
        exports: result.exports,
        snippet: result.snippet,
      });
      edges.push(...result.edges);
      uncertain.push(...result.uncertain);
      externalEdges.push(...result.externalEdges);
    }

    // Load-time validation (ADR 003): empty-selector-fails-by-default, package selectors must
    // resolve against the workspace inventory. Runs after the scan since v1 has no separate
    // config-build step — the first fresh scan IS "load time." A thrown error here propagates as
    // a rejected promise, which the orchestrator turns into gate 'error' (ADR 008: a
    // misconfiguration is environmental, not a code violation).
    validateComponents(
      input.components,
      nodes.map((n) => n.file),
      workspaceIndex,
      blindSpots,
    );

    return {
      nodes,
      edges,
      externalNodes: [...externalNodesById.values()],
      externalEdges,
      uncertain,
      blindSpots,
      scannedAt,
    };
  }
}

/** Reuses an existing string reference from `cache` for an equal string, or registers `value` as
 * its own canonical reference — the interning half of the memory-bound work above. */
function intern(cache: Map<string, string>, value: string): string {
  const existing = cache.get(value);
  if (existing !== undefined) return existing;
  cache.set(value, value);
  return value;
}

interface WalkResult {
  readonly files: string[];
  readonly blindSpots: ScanBlindSpot[];
}

/**
 * Task #25: a nested git checkout — a `git worktree`, a submodule, a vendored clone, anything
 * carrying its own `.git` — is never part of THIS repo's architecture and is auto-excluded during
 * the walk. A linked worktree's `.git` is a FILE (pointing at the real repo's `.git/worktrees/...`
 * entry), not a directory, so `fs.existsSync` is used deliberately instead of an `isDirectory()`
 * check — it's true either way, one cheap existence check per directory as we descend, not a
 * repo-wide scan.
 */
function hasOwnGit(absDir: string): boolean {
  return fs.existsSync(path.join(absDir, '.git'));
}

/**
 * The one walk, and the one place align learns what it could NOT see (ADR 028). Every `return`,
 * `continue` and fall-through below that drops a path now records a `ScanBlindSpot` with its reason,
 * because a consumer of absence (`applyMoves` infers "renamed", `store.prune` infers "fixed",
 * `validateComponents` infers "empty component") otherwise reads a path this walk declined to look
 * at as a path the repository no longer has. Two of those confusions were reproduced against the
 * built binary and both destroy a human consent record at exit 0.
 *
 * BOUNDED BY CONSTRUCTION. A skipped directory is recorded once and never descended into, so
 * `node_modules` contributes ONE record rather than one per file beneath it, and matching is
 * at-or-under (`core/src/baseline/scan-blind-spots.ts`) so the single record still covers every file
 * in the subtree. That bound is a Stage 1 success criterion and is pinned by a test.
 *
 * ONE MECHANISM IS DELIBERATELY MISSING. An extension outside `SOURCE_EXTENSIONS` (ADR 028's
 * mechanism #6) is NOT recorded: enumerating every non-source file in a repository is expensive and
 * noisy, and ADR 028's second mechanism — the injected existence probe, Stage 2 — covers the case
 * that matters without it. That is the ONLY exit here that is silent on purpose.
 */
function walkSourceFiles(
  repoRoot: string,
  excludes: readonly string[],
  includeNestedCheckouts: readonly string[],
): WalkResult {
  const files: string[] = [];
  const blindSpots: ScanBlindSpot[] = [];
  const record = (relPath: string, reason: ScanBlindSpotReason): void => {
    blindSpots.push({ path: toRepoRelativePath(relPath), reason });
  };

  const visit = (absDir: string): void => {
    const relDir = path.relative(repoRoot, absDir).split(path.sep).join('/');
    const excludePattern = matchingExcludePatternForDirectory(relDir, excludes);
    if (excludePattern !== undefined) {
      record(relDir, { kind: 'excluded', pattern: excludePattern });
      return;
    }
    // `relDir === ''` is the scan root itself (`rootDir`, the caller-supplied scan boundary) —
    // exempted structurally, by construction, regardless of whether it happens to have a `.git` of
    // its own. Nothing here assumes it does: align scans a plain non-git directory fine (every
    // fixture/tmpdir test in this suite proves it), so this is not "the root always has one and we
    // trust that" — it is "this function's job is to find checkouts NESTED BELOW the root; the
    // root itself is never a candidate to skip, full stop."
    if (relDir !== '' && hasOwnGit(absDir) && !isExcludedPath(relDir, includeNestedCheckouts)) {
      record(relDir, { kind: 'nested-checkout' });
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      // Read-only survey posture: skip rather than crash — but never silently. This exit was the
      // most dangerous of the six before ADR 028, and it stayed dangerous even after this release's
      // `unverified-prune.ts` work, which reports only entries WITHOUT a `contentFingerprint` while
      // `baseline accept` always writes one. `fs.existsSync` does not rescue it either: it swallows
      // the EACCES and reports a file inside a chmod 000 directory as ABSENT, which is exactly why
      // ADR 028 needs this record AND the probe rather than the probe alone.
      //
      // `relDir` is `''` when the scan ROOT itself is unreadable. That is a real, if rare, case, and
      // the containment test treats `''` as covering the whole repo precisely so it retains
      // everything instead of matching nothing — see `isUnderDirectory` in core.
      record(relDir, { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const entry of entries) {
      const relEntry = path.relative(repoRoot, path.join(absDir, entry.name)).split(path.sep).join('/');
      // BEFORE the isDirectory()/isFile() branch, deliberately. `readdirSync(…, {withFileTypes:
      // true})` does not follow symlinks, so a SYMLINKED `node_modules` or `dist` answers false to
      // both and would otherwise be filed under `not-regular-file` — technically true, but it buries
      // the always-excluded case (which every repo has, and which nobody needs to act on) among the
      // symlink records (which are surprising and DO need attention). Checked this repo: its
      // `node_modules` directories are real, so this is not the universal case an earlier draft
      // claimed — but it occurs in generated and container layouts, and the fix is free.
      if (DEFAULT_EXCLUDED_DIR_NAMES.has(entry.name)) {
        record(relEntry, { kind: 'default-excluded-dir', name: entry.name });
        continue;
      }
      if (entry.isDirectory()) {
        visit(path.join(absDir, entry.name));
        continue;
      }
      if (entry.isFile()) {
        // Mechanism #6, the one deliberate silence — see this function's doc comment.
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
        const filePattern = matchingExcludePattern(relEntry, excludes);
        if (filePattern !== undefined) {
          record(relEntry, { kind: 'excluded', pattern: filePattern });
          continue;
        }
        files.push(path.join(absDir, entry.name));
        continue;
      }
      // Neither a regular file nor a directory. A symlink lands here — `isDirectory()` and
      // `isFile()` are BOTH false for one — and before ADR 028 it fell off the end of this loop with
      // no record and not even an uncertainty marker, so an entire symlinked subtree vanished. So do
      // FIFOs, sockets, block/character devices; recording them costs nothing and keeps this arm
      // total rather than a symlink special case.
      record(relEntry, { kind: 'not-regular-file' });
    }
  };
  visit(repoRoot);
  files.sort();
  blindSpots.sort((a, b) => a.path.localeCompare(b.path));
  return { files, blindSpots };
}

// Exclude patterns use core's glob dialect (`globMatch`) so a component selector and an
// exclude pattern with the same text always mean the same thing (BUG #4: this used to be a
// second, independent glob implementation that diverged from core's dialect three ways --
// missing segment-boundary handling on a leading `**/`, no brace expansion, and a literal-space
// placeholder that silently over-matched patterns containing a real space). The two
// literal-prefix arms below are kept: core's `globMatch` has no implicit directory-prefix
// semantics, so removing them would break a plain `dist` exclude matching `dist/x.ts`.
//
// Returns the PATTERN rather than a boolean (ADR 028) so a blind-spot record can name the one
// responsible instead of leaving the user to guess which of their excludes hid the path — the
// reason-reporting requirement of ADR 028 §3, which exists because silent retention reads
// identically to "nothing to prune". `isExcludedPath` below is the boolean view for callers that
// only need the decision.
function matchingExcludePattern(relPath: string, excludes: readonly string[]): string | undefined {
  if (relPath === '') return undefined;
  return excludes.find(
    (pattern) => relPath === pattern || relPath.startsWith(`${pattern}/`) || globMatch(pattern, relPath),
  );
}

function isExcludedPath(relPath: string, excludes: readonly string[]): boolean {
  return matchingExcludePattern(relPath, excludes) !== undefined;
}

/**
 * The directory arm of the same question, and the reason it needs its own function: a pattern of
 * the form `<prefix>/**` does NOT match `<prefix>` itself under core's glob dialect. Before ADR 028
 * that only cost a wasted descent — every file underneath matched the pattern individually and was
 * dropped one by one, so `files` came out identical. Now it costs a blind-spot record PER FILE
 * instead of one for the subtree, which turns a bounded record into an unbounded one: the very
 * failure mode Stage 1's volume criterion exists to prevent, and one a real `excludes: ['**\/dist/**']`
 * would hit on every scan.
 *
 * Sound because `<prefix>/**` matches exactly the descendants of `<prefix>`: if a directory is at or
 * under `<prefix>`, every path beneath it is a descendant of `<prefix>` and therefore already
 * excluded, so descending can only rediscover that. `files` is unchanged by construction — this
 * narrows what the walk WALKS, never what it includes. `'**'` on its own is not a `<prefix>/**` and
 * is left to the ordinary test above, which already matches any directory.
 *
 * Brace groups are expanded FIRST (`expandBraces`, core's own dialect — never a second
 * implementation, BUG #4's lesson) because the `/**` can live inside one: `src/{a/**,b/**}` does not
 * end in `/**` as written, so testing the raw pattern let the walk descend and record one blind spot
 * per file. Measured on a 10-file fixture: 10 records for the brace form against 2 for the
 * equivalent `['src/a/**','src/b/**']`, with identical `files` — the bound broken, not correctness.
 */
export function matchingExcludePatternForDirectory(relDir: string, excludes: readonly string[]): string | undefined {
  const direct = matchingExcludePattern(relDir, excludes);
  if (direct !== undefined) return direct;
  if (relDir === '') return undefined;
  return excludes.find((pattern) =>
    expandBraces(pattern).some((member) => {
      if (!member.endsWith('/**')) return false;
      const prefix = member.slice(0, -'/**'.length);
      return relDir === prefix || relDir.startsWith(`${prefix}/`) || globMatch(prefix, relDir);
    }),
  );
}

function scanFile(
  absPath: string,
  repoRoot: string,
  resolver: TsconfigResolver,
  excludes: readonly string[],
  workspacePackages: readonly WorkspacePackage[],
  externalStringIntern: Map<string, string>,
  externalNodesById: Map<string, ExternalPackageNode>,
): FileScanResult {
  const text = fs.readFileSync(absPath, 'utf8');
  const relPath = toRepoRelativePath(path.relative(repoRoot, absPath).split(path.sep).join('/'));
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);
  const lines = text.split('\n');

  const edges: DependencyGraphEdge[] = [];
  const externalEdges: ExternalDependencyEdge[] = [];
  const uncertain: UncertaintyMarker[] = [];

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const snippetAt = (line: number): string => (lines[line - 1] ?? '').trim();

  const recordSpecifier = (
    specifier: string,
    kind: EdgeKind,
    line: number,
    // ADR 016 (public-surface inference): only meaningful for export-declaration call sites — see
    // DependencyGraphEdge.isBarrelReexport's doc comment for why this bit can't be recovered from
    // `kind` alone.
    isBarrelReexport?: boolean,
  ): void => {
    const target = resolver.resolveSpecifier(specifier, absPath);
    switch (target.kind) {
      case 'internal': {
        const targetRel = toRepoRelativePath(path.relative(repoRoot, target.absolutePath).split(path.sep).join('/'));
        const ext = path.extname(target.absolutePath);
        if (!SOURCE_EXTENSIONS.has(ext)) {
          if (ASSET_EXTENSIONS.has(ext)) {
            uncertain.push({ file: relPath, specifier, line, reason: 'asset-specifier' });
          }
          // Non-source, non-asset internal targets (e.g. .d.ts) are silently not graph nodes —
          // not uncertainty, just out of scope for the source-level edge graph.
          return;
        }
        if (isExcludedPath(targetRel, excludes)) {
          uncertain.push({ file: relPath, specifier, line, reason: 'build-output-excluded' });
          return;
        }
        edges.push({
          from: relPath,
          to: targetRel,
          specifier,
          line,
          kind,
          snippet: snippetAt(line),
          ...(isBarrelReexport === undefined ? {} : { isBarrelReexport }),
        });
        return;
      }
      case 'external': {
        // External-package retention (Stage 5 infra, docs/proposals/rule-expansion-evaluation.md's
        // top-of-document correction #2): previously discarded here entirely. Uncertainty
        // classification is unaffected — this specifier already resolved cleanly to 'external',
        // it was never on the `unresolved` path, so nothing about the uncertainty vocabulary
        // changes; only the discard behavior does. Name-level node, interned (see `scan()`'s doc
        // comment) so the same package imported from thousands of files shares one id string.
        const packageName = intern(externalStringIntern, target.packageName);
        const nodeId = intern(
          externalStringIntern,
          target.isBuiltin ? `external:node:${packageName}` : `external:${packageName}`,
        );
        if (!externalNodesById.has(nodeId)) {
          externalNodesById.set(nodeId, { id: nodeId, packageName, isBuiltin: target.isBuiltin });
        }
        externalEdges.push({
          from: relPath,
          to: nodeId,
          specifier: intern(externalStringIntern, specifier),
          line,
          kind,
          snippet: snippetAt(line),
        });
        return;
      }
      case 'unresolved': {
        const ext = path.extname(specifier.split('?')[0] ?? specifier);
        uncertain.push({
          file: relPath,
          specifier,
          line,
          reason: ASSET_EXTENSIONS.has(ext) ? 'asset-specifier' : 'unresolvable-specifier',
        });
        return;
      }
      default: {
        const exhaustive: never = target;
        throw new Error(`unhandled resolution: ${JSON.stringify(exhaustive)}`);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const kind: EdgeKind = node.importClause?.isTypeOnly === true ? 'type-only' : 'import';
      recordSpecifier(node.moduleSpecifier.text, kind, lineOf(node));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const kind: EdgeKind = node.isTypeOnly ? 'type-only' : 'reexport';
      // Mirrors exports.ts:44's exact bare-star check (`exportClause === undefined`) — the same
      // AST fact, captured here too so the edge itself carries it (ADR 016).
      recordSpecifier(node.moduleSpecifier.text, kind, lineOf(node), node.exportClause === undefined);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        recordSpecifier(arg.text, 'dynamic', lineOf(node));
      } else {
        uncertain.push({ file: relPath, specifier: arg?.getText(sourceFile).slice(0, 80) ?? '', line: lineOf(node), reason: 'non-literal-dynamic-specifier' });
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        recordSpecifier(arg.text, 'import', lineOf(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // `export * from './other'` barrel targets are not enumerated here — see exports.ts's module
  // doc comment for why (cross-file resolution, out of scope for this per-file syntactic pass).
  //
  // `text.split('\n')` yields a trailing empty-string element for any file ending in a newline
  // (essentially every file an editor or formatter writes), which is not a real line — so
  // `lines.length` alone over-counts by one. Subtract it off when present.
  //
  // This deliberately does NOT match `wc -l`: for a file whose last line lacks a trailing
  // newline (e.g. "a\nb\nc"), this reports 3 lines while `wc -l` reports 2 (it counts newline
  // characters, not lines). Three lines of code is the correct answer for a LOC metric — do not
  // "fix" this toward `wc -l`.
  const loc = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);

  return {
    edges,
    externalEdges,
    uncertain,
    loc,
    exports: extractExportedSymbols(sourceFile),
    snippet: snippetAt(1),
  };
}
