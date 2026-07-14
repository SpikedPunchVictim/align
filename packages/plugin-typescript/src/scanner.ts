/**
 * Per-file syntactic scan-and-discard (ADR 004): parse each file with the TypeScript compiler
 * API (not ts-morph — the raw compiler API is the spike-proven implementation), extract edges,
 * discard the AST immediately. Ported from docs/evidence/kluster-spike/src/scanner.ts, adapted to core's `Scanner`
 * contract and extended with the asset-specifier / configurable-build-output-exclude vocabulary
 * and snippet capture (needed for `Violation.snippet`, see @spikedpunch/align-core's documented deviation).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {
  classifyFile,
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
  type ScanInput,
  type Scanner,
  type UncertaintyMarker,
} from '@spikedpunch/align-core';
import { extractExportedSymbols } from './exports.js';
import { TsconfigResolver } from './tsconfig-resolver.js';
import { loadWorkspacePackages, type WorkspacePackage } from './workspace.js';

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
const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
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
    const files = walkSourceFiles(rootDir, excludes);

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
    );

    return { nodes, edges, externalNodes: [...externalNodesById.values()], externalEdges, uncertain, scannedAt };
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

function walkSourceFiles(repoRoot: string, excludes: readonly string[]): string[] {
  const files: string[] = [];
  const visit = (absDir: string): void => {
    const relDir = path.relative(repoRoot, absDir).split(path.sep).join('/');
    if (isExcludedPath(relDir, excludes)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: read-only survey posture, skip rather than crash
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIR_NAMES.has(entry.name)) visit(path.join(absDir, entry.name));
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const relFile = path.relative(repoRoot, path.join(absDir, entry.name)).split(path.sep).join('/');
        if (!isExcludedPath(relFile, excludes)) files.push(path.join(absDir, entry.name));
      }
    }
  };
  visit(repoRoot);
  files.sort();
  return files;
}

function isExcludedPath(relPath: string, excludes: readonly string[]): boolean {
  if (relPath === '') return false;
  return excludes.some((pattern) => relPath === pattern || relPath.startsWith(`${pattern}/`) || globLikeMatch(pattern, relPath));
}

/** Minimal glob support for exclude patterns (e.g. `**\/*.generated.ts`) without pulling in a
 * new dependency — reuses the same small pattern vocabulary as @spikedpunch/align-core's component globs. */
function globLikeMatch(pattern: string, filePath: string): boolean {
  if (!pattern.includes('*')) return false;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
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

  const recordSpecifier = (specifier: string, kind: EdgeKind, line: number): void => {
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
        edges.push({ from: relPath, to: targetRel, specifier, line, kind, snippet: snippetAt(line) });
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
      recordSpecifier(node.moduleSpecifier.text, kind, lineOf(node));
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
  return {
    edges,
    externalEdges,
    uncertain,
    loc: lines.length,
    exports: extractExportedSymbols(sourceFile),
    snippet: snippetAt(1),
  };
}
