/**
 * Syntactic per-file import scanner.
 *
 * Each file is parsed with ts.createSourceFile, its import/export edges extracted,
 * and the AST discarded immediately — only primitive edge data escapes scanFile.
 * This is deliberate: the spike measures the memory profile of scan-and-discard.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { TsconfigResolver } from './tsconfig-resolver.js';
import type {
  EdgeKind,
  Graph,
  GraphEdge,
  GraphNode,
  ScanStats,
  UncertainContext,
  UncertainEdge,
  UncertainReason,
} from './types.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '.build', '.history', '.git']);
/** User directive: this subtree is pipeline test-run output, not source. */
const EXCLUDED_SUBTREES = ['packages/workbench/sdd/apps'];

interface FileScanResult {
  readonly edges: GraphEdge[];
  readonly uncertain: UncertainEdge[];
  readonly externalPackages: string[];
  readonly loc: number;
}

export function walkSourceFiles(repoRoot: string, scanRoots: readonly string[]): string[] {
  const files: string[] = [];
  const visit = (absDir: string): void => {
    const relDir = path.relative(repoRoot, absDir).split(path.sep).join('/');
    if (EXCLUDED_SUBTREES.some((sub) => relDir === sub || relDir.startsWith(`${sub}/`))) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, this is a read-only survey
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIR_NAMES.has(entry.name)) visit(path.join(absDir, entry.name));
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.join(absDir, entry.name));
      }
    }
  };
  for (const root of scanRoots) {
    const abs = path.join(repoRoot, root);
    if (fs.existsSync(abs)) visit(abs);
  }
  files.sort();
  return files;
}

export function scanFile(absPath: string, repoRoot: string, resolver: TsconfigResolver): FileScanResult {
  const text = fs.readFileSync(absPath, 'utf8');
  const relPath = path.relative(repoRoot, absPath).split(path.sep).join('/');
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);

  const edges: GraphEdge[] = [];
  const uncertain: UncertainEdge[] = [];
  const externalPackages: string[] = [];

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const recordSpecifier = (specifier: string, kind: EdgeKind, context: UncertainContext, line: number): void => {
    const target = resolver.resolveSpecifier(specifier, absPath);
    switch (target.kind) {
      case 'internal':
        edges.push({ from: relPath, to: target.repoRelativePath, kind, specifier, line });
        return;
      case 'external':
        externalPackages.push(target.packageName);
        return;
      case 'unresolved':
        uncertain.push({ file: relPath, reason: 'unresolvable-specifier', context, specifierPreview: specifier, line });
        return;
      default: {
        const _exhaustive: never = target;
        throw new Error(`unhandled resolution: ${JSON.stringify(_exhaustive)}`);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const kind: EdgeKind = node.importClause?.isTypeOnly === true ? 'type-only' : 'import';
      recordSpecifier(node.moduleSpecifier.text, kind, 'import', lineOf(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const isStar = node.exportClause === undefined;
      const kind: EdgeKind = node.isTypeOnly ? 'type-only' : 'reexport';
      recordSpecifier(node.moduleSpecifier.text, kind, isStar ? 'export-star' : 'reexport', lineOf(node));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        recordSpecifier(arg.text, 'dynamic', 'dynamic', lineOf(node));
      } else {
        uncertain.push({
          file: relPath,
          reason: 'non-literal-dynamic-specifier',
          context: 'dynamic',
          specifierPreview: arg === undefined ? undefined : arg.getText(sourceFile).slice(0, 80),
          line: lineOf(node),
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        recordSpecifier(arg.text, 'import', 'import', lineOf(node));
      }
      // Non-literal require: exceedingly rare in this repo; treated as out of scope.
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // The sourceFile goes out of scope here — nothing returned references the AST.
  return { edges, uncertain, externalPackages, loc: text.split('\n').length };
}

export interface ScanResult {
  readonly graph: Graph;
  readonly stats: ScanStats;
}

export function scanRepo(repoRoot: string, scanRoots: readonly string[]): ScanResult {
  const heapMb = (): number => process.memoryUsage().heapUsed / (1024 * 1024);
  const heapBefore = heapMb();
  let peakHeap = heapBefore;
  const started = performance.now();

  const resolver = new TsconfigResolver(repoRoot);
  const files = walkSourceFiles(repoRoot, scanRoots);

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const uncertain: UncertainEdge[] = [];
  const externalPackages = new Set<string>();
  let totalLoc = 0;

  let scanned = 0;
  for (const file of files) {
    const result = scanFile(file, repoRoot, resolver);
    const relPath = path.relative(repoRoot, file).split(path.sep).join('/');
    nodes.set(relPath, { path: relPath, loc: result.loc });
    edges.push(...result.edges);
    uncertain.push(...result.uncertain);
    for (const pkg of result.externalPackages) externalPackages.add(pkg);
    totalLoc += result.loc;

    scanned += 1;
    if (scanned % 100 === 0) peakHeap = Math.max(peakHeap, heapMb());
  }

  const wallTimeMs = performance.now() - started;
  const heapAfter = heapMb();
  peakHeap = Math.max(peakHeap, heapAfter);

  const edgeCountsByKind: Record<EdgeKind, number> = { import: 0, reexport: 0, dynamic: 0, 'type-only': 0 };
  for (const edge of edges) edgeCountsByKind[edge.kind] += 1;

  const uncertainCountByReason: Record<UncertainReason, number> = {
    'non-literal-dynamic-specifier': 0,
    'unresolvable-specifier': 0,
  };
  for (const u of uncertain) uncertainCountByReason[u.reason] += 1;

  return {
    graph: { nodes, edges, uncertain, externalPackages },
    stats: {
      wallTimeMs,
      filesScanned: files.length,
      totalLoc,
      nodeCount: nodes.size,
      edgeCountsByKind,
      uncertainCountByReason,
      uncertainFileCount: new Set(uncertain.map((u) => u.file)).size,
      externalPackageCount: externalPackages.size,
      heapUsedBeforeMb: round1(heapBefore),
      heapUsedAfterMb: round1(heapAfter),
      peakHeapUsedMb: round1(peakHeap),
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
