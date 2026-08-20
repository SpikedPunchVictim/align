/**
 * Nearest-tsconfig discovery + module resolution via the TypeScript compiler API (ADR 004).
 * Ported from docs/adr/proposals/graph-extraction/kluster-spike/src/tsconfig-resolver.ts (proven implementation) — same algorithm, same
 * realpath-classification fix, same include/files stripping trap avoidance, adapted to also
 * consult the workspace-name resolver fallback (ADR 004, new since the spike) before giving up.
 */
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import ts from 'typescript';
import { resolveWorkspaceSpecifier, type WorkspacePackage } from './workspace.js';
import { DEFAULT_EXCLUDED_DIR_NAMES } from './scan-scope.js';

const BUILTINS = new Set(builtinModules);

export type ResolvedTarget =
  | { readonly kind: 'internal'; readonly absolutePath: string }
  // `isBuiltin` distinguishes a Node builtin (`node:child_process`, bare `fs`) from an npm
  // package for external-edge retention (Stage 5 infra) — the scanner uses it to build
  // `ExternalPackageNode.id` ('external:node:<name>' vs 'external:<name>').
  | { readonly kind: 'external'; readonly packageName: string; readonly isBuiltin: boolean }
  | { readonly kind: 'unresolved' };

export class TsconfigResolver {
  private readonly tsconfigByDir = new Map<string, string | undefined>();
  private readonly optionsByTsconfig = new Map<string, ts.CompilerOptions>();
  private readonly resolutionCache = new Map<string, ResolvedTarget>();

  constructor(
    private readonly repoRoot: string,
    private readonly workspacePackages: readonly WorkspacePackage[],
  ) {}

  resolveSpecifier(specifier: string, containingFile: string): ResolvedTarget {
    if (specifier.startsWith('node:') || BUILTINS.has(specifier)) {
      return { kind: 'external', packageName: specifier.replace(/^node:/, ''), isBuiltin: true };
    }

    const dir = path.dirname(containingFile);
    const cacheKey = `${dir}\u0000${specifier}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = this.resolveUncached(specifier, containingFile, dir);
    this.resolutionCache.set(cacheKey, result);
    return result;
  }

  private resolveUncached(specifier: string, containingFile: string, dir: string): ResolvedTarget {
    const options = this.optionsForDir(dir);
    const resolution = ts.resolveModuleName(specifier, containingFile, options, ts.sys);
    const resolved = resolution.resolvedModule;

    if (resolved === undefined) {
      // Workspace-name resolver fallback (ADR 004): a bare specifier the compiler couldn't find
      // may still be a workspace package whose node_modules symlink doesn't exist yet (no
      // `pnpm install`) or whose declared entry is a not-yet-built `dist/`. Resolve directly from
      // the workspace inventory before reporting uncertainty.
      const fallback = resolveWorkspaceSpecifier(specifier, this.workspacePackages, this.repoRoot);
      if (fallback !== undefined) return { kind: 'internal', absolutePath: fallback };
      return { kind: 'unresolved' };
    }

    // pnpm realpath classification (ADR 004, v1 HARD requirement): in a pnpm workspace,
    // inter-package imports resolve THROUGH node_modules symlinks, so both
    // `isExternalLibraryImport` and a node_modules substring check on the *symlink* path
    // misclassify internal cross-package edges as external. Realpath first, then classify by
    // where the file actually lives.
    const realPath = this.realpathOf(resolved.resolvedFileName);
    const rel = path.relative(this.repoRoot, realPath);
    const insideRepo = !rel.startsWith('..') && !path.isAbsolute(rel);
    const inNodeModules = rel.split(path.sep).includes('node_modules');
    if (!insideRepo || inNodeModules) {
      return { kind: 'external', packageName: packageNameFromSpecifier(specifier), isBuiltin: false };
    }
    // OPTION A: TS stays authoritative, EXCEPT when its internal answer lands somewhere the walk
    // will never turn into a node — a default-excluded directory (`dist`, `build`, ...). Remap
    // through the workspace inventory to the package's source entry.
    if (rel.split(path.sep).some((seg) => DEFAULT_EXCLUDED_DIR_NAMES.has(seg))) {
      const remapped = resolveWorkspaceSpecifier(specifier, this.workspacePackages, this.repoRoot);
      if (remapped !== undefined) return { kind: 'internal', absolutePath: remapped };
    }
    return { kind: 'internal', absolutePath: realPath };
  }

  private realpathOf(p: string): string {
    if (ts.sys.realpath === undefined) return p;
    try {
      return ts.sys.realpath(p);
    } catch {
      return p;
    }
  }

  private optionsForDir(dir: string): ts.CompilerOptions {
    const tsconfigPath = this.findNearestTsconfig(dir);
    if (tsconfigPath === undefined) {
      return { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true };
    }
    const cached = this.optionsByTsconfig.get(tsconfigPath);
    if (cached !== undefined) return cached;

    const options = this.parseTsconfig(tsconfigPath);
    this.optionsByTsconfig.set(tsconfigPath, options);
    return options;
  }

  private parseTsconfig(tsconfigPath: string): ts.CompilerOptions {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.config === undefined) {
      return { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true };
    }
    // ADR-level trap: strip include/files before parseJsonConfigFileContent, or it enumerates
    // every input file per tsconfig — pure wasted I/O that only shows up at repo scale.
    const config = read.config as Record<string, unknown>;
    delete config['include'];
    delete config['exclude'];
    config['files'] = [];
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(tsconfigPath));
    const options = { ...parsed.options };
    if (options.moduleResolution === undefined) {
      options.moduleResolution = ts.ModuleResolutionKind.NodeNext;
    }
    options.allowJs = true;
    return options;
  }

  private findNearestTsconfig(startDir: string): string | undefined {
    const cached = this.tsconfigByDir.get(startDir);
    if (cached !== undefined || this.tsconfigByDir.has(startDir)) return cached;

    const visited: string[] = [];
    let dir = startDir;
    let found: string | undefined;
    for (;;) {
      const known = this.tsconfigByDir.get(dir);
      if (known !== undefined || this.tsconfigByDir.has(dir)) {
        found = known;
        break;
      }
      visited.push(dir);
      const candidate = path.join(dir, 'tsconfig.json');
      if (ts.sys.fileExists(candidate)) {
        found = candidate;
        break;
      }
      if (dir === this.repoRoot) break; // repo root is the hard stop
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root safety stop
      dir = parent;
    }
    for (const d of visited) this.tsconfigByDir.set(d, found);
    return found;
  }
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return specifier;
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}
