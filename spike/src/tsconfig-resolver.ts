/**
 * Nearest-tsconfig discovery + module resolution via the TypeScript compiler API.
 *
 * For each source file we walk up to the nearest tsconfig.json (stopping at the repo
 * root), parse it with `extends` chains resolved, and hand its compilerOptions to
 * ts.resolveModuleName. Everything is cached: tsconfig lookup per directory, parsed
 * options per tsconfig path, and resolution results per (directory, specifier) pair.
 */

import { builtinModules } from 'node:module';
import * as path from 'node:path';
import ts from 'typescript';
import type { ResolvedTarget } from './types.js';

const BUILTINS = new Set(builtinModules);

export class TsconfigResolver {
  private readonly tsconfigByDir = new Map<string, string | undefined>();
  private readonly optionsByTsconfig = new Map<string, ts.CompilerOptions>();
  private readonly resolutionCache = new Map<string, ResolvedTarget>();

  constructor(private readonly repoRoot: string) {}

  resolveSpecifier(specifier: string, containingFile: string): ResolvedTarget {
    if (specifier.startsWith('node:') || BUILTINS.has(specifier)) {
      return { kind: 'external', packageName: specifier.replace(/^node:/, '') };
    }

    const dir = path.dirname(containingFile);
    const cacheKey = `${dir}\0${specifier}`;
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
      // Bare specifier that the compiler could not find. If it looks like an npm
      // package (not relative, not an alias that should have matched), we still
      // report it as unresolved — that IS the uncertainty signal we are measuring.
      return { kind: 'unresolved' };
    }

    // SPIKE FINDING: in a pnpm monorepo, workspace packages resolve THROUGH node_modules
    // symlinks, so both `isExternalLibraryImport` and a node_modules substring check
    // misclassify internal cross-package edges as external — silently cutting every
    // inter-package dependency edge from the graph. Realpath first, then classify by
    // where the file actually lives.
    const realPath = this.realpathOf(resolved.resolvedFileName);
    const rel = path.relative(this.repoRoot, realPath);
    const insideRepo = !rel.startsWith('..') && !path.isAbsolute(rel);
    const inNodeModules = rel.split(path.sep).includes('node_modules');
    if (!insideRepo || inNodeModules) {
      return { kind: 'external', packageName: packageNameFromSpecifier(specifier) };
    }
    return { kind: 'internal', repoRelativePath: rel.split(path.sep).join('/') };
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
    // Suppress input-file enumeration: we only want compilerOptions (paths, baseUrl,
    // moduleResolution) with the extends chain applied. Enumerating "include" globs
    // for ~90 tsconfigs would be pure wasted I/O for this use case.
    const config = read.config as Record<string, unknown>;
    delete config['include'];
    delete config['exclude'];
    config['files'] = [];
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(tsconfigPath));
    // "No inputs found" diagnostics are expected (files: []) and ignored deliberately.
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
