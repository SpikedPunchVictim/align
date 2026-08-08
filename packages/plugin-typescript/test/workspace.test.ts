import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFile, toComponentName, toRepoRelativePath, validateComponents } from '@spikedpunch/align-core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkspacePackages, readWorkspaceGlobs, resolveWorkspaceSpecifier } from '../src/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wsRoot = path.join(here, 'fixtures', 'pnpm-workspace');

const tmpDirs: string[] = [];
function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-ws-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe('readWorkspaceGlobs', () => {
  it('reads pnpm-workspace.yaml `packages:`', () => {
    const dir = makeRepo({ 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\n" });
    expect(readWorkspaceGlobs(dir)).toEqual(['packages/*', 'apps/*']);
  });

  it('reads the npm/bun package.json `workspaces` array form', () => {
    const dir = makeRepo({ 'package.json': JSON.stringify({ name: 'r', workspaces: ['packages/*', 'apps/*'] }) });
    expect(readWorkspaceGlobs(dir)).toEqual(['packages/*', 'apps/*']);
  });

  it('reads the yarn-classic package.json `workspaces` object form', () => {
    const dir = makeRepo({ 'package.json': JSON.stringify({ name: 'r', workspaces: { packages: ['packages/*'], nohoist: ['**/x'] } }) });
    expect(readWorkspaceGlobs(dir)).toEqual(['packages/*']);
  });

  it('prefers pnpm-workspace.yaml over a package.json workspaces field when both exist', () => {
    const dir = makeRepo({
      'pnpm-workspace.yaml': "packages:\n  - 'pnpm-pkgs/*'\n",
      'package.json': JSON.stringify({ name: 'r', workspaces: ['npm-pkgs/*'] }),
    });
    expect(readWorkspaceGlobs(dir)).toEqual(['pnpm-pkgs/*']);
  });

  it('reads lerna.json `packages` when there is no pnpm/package.json workspace declaration (lerna monorepo, e.g. nest)', () => {
    const dir = makeRepo({
      'lerna.json': JSON.stringify({ packages: ['packages/*'], version: '11.0.0' }),
      'package.json': JSON.stringify({ name: 'r' }), // no `workspaces` field — nest's exact shape
    });
    expect(readWorkspaceGlobs(dir)).toEqual(['packages/*']);
  });

  it("defaults a lerna.json with no `packages` field to lerna's own default ['packages/*']", () => {
    const dir = makeRepo({ 'lerna.json': JSON.stringify({ version: '11.0.0' }) });
    expect(readWorkspaceGlobs(dir)).toEqual(['packages/*']);
  });

  it('prefers a package.json workspaces field over lerna.json (the PM is what actually globs)', () => {
    const dir = makeRepo({
      'lerna.json': JSON.stringify({ packages: ['lerna-pkgs/*'] }),
      'package.json': JSON.stringify({ name: 'r', workspaces: ['npm-pkgs/*'] }),
    });
    expect(readWorkspaceGlobs(dir)).toEqual(['npm-pkgs/*']);
  });

  it('returns [] for a single-package repo with no workspace declaration', () => {
    const dir = makeRepo({ 'package.json': JSON.stringify({ name: 'r' }) });
    expect(readWorkspaceGlobs(dir)).toEqual([]);
  });

  it('returns [] on a malformed package.json (read-only survey posture, never throws)', () => {
    const dir = makeRepo({ 'package.json': '{ not valid json' });
    expect(readWorkspaceGlobs(dir)).toEqual([]);
  });
});

describe('loadWorkspacePackages', () => {
  it('discovers workspace packages from pnpm-workspace.yaml without requiring node_modules', () => {
    const packages = loadWorkspacePackages(wsRoot);
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual(['@fixture/pkg-a', '@fixture/pkg-b']);
  });

  it('returns an empty array when there is no pnpm-workspace.yaml', () => {
    const packages = loadWorkspacePackages(path.join(here, 'fixtures', 'clean'));
    expect(packages).toEqual([]);
  });

  // Needs-Review 1 (root workspace packages): when the workspace declaration resolves the repo
  // root itself to a package directory, `path.relative(rootDir, rootDir)` is `''`. The package's
  // `dir` must stay `''`, not `'/'` — `'/'` matches no repo-relative file (`file.startsWith('/')`
  // is false for every scanned path), which classified the root package to zero files.
  describe('root workspace package (dir stays "", not "/")', () => {
    it('npm `workspaces: ["."]` resolves the root package.json to dir: ""', () => {
      const dir = makeRepo({ 'package.json': JSON.stringify({ name: 'rootpkg', workspaces: ['.'] }) });
      const packages = loadWorkspacePackages(dir);
      expect(packages).toEqual([{ name: 'rootpkg', dir: '' }]);
    });

    it('npm `workspaces: [""]` resolves the root package.json to dir: ""', () => {
      const dir = makeRepo({ 'package.json': JSON.stringify({ name: 'rootpkg', workspaces: [''] }) });
      const packages = loadWorkspacePackages(dir);
      expect(packages).toEqual([{ name: 'rootpkg', dir: '' }]);
    });

    it('pnpm `packages: ["**"]` includes the root package.json at dir: ""', () => {
      const dir = makeRepo({
        'pnpm-workspace.yaml': "packages:\n  - '**'\n",
        'package.json': JSON.stringify({ name: 'rootpkg' }),
      });
      const packages = loadWorkspacePackages(dir);
      expect(packages).toEqual([{ name: 'rootpkg', dir: '' }]);
    });

    it('a root-package component classifies files instead of erroring as a stale/zero-match selector', () => {
      const dir = makeRepo({ 'package.json': JSON.stringify({ name: 'rootpkg', workspaces: ['.'] }) });
      const packages = loadWorkspacePackages(dir);
      const workspaceIndex = new Map(packages.map((p) => [p.name, toRepoRelativePath(p.dir)]));
      const components = {
        [toComponentName('root')]: {
          name: 'root',
          selector: { kind: 'package' as const, packageNames: ['rootpkg'] },
          empty: 'fail' as const,
        },
      };
      const srcIndexFile = toRepoRelativePath('src/index.ts');
      const files = [srcIndexFile, toRepoRelativePath('package.json')];
      // Previously: `dir: '/'` meant this threw ComponentValidationError ("matches zero files").
      expect(() => validateComponents(components, files, workspaceIndex)).not.toThrow();
      expect(classifyFile(srcIndexFile, components, workspaceIndex)).toBe('root');
    });
  });
});

describe('resolveWorkspaceSpecifier (workspace-name resolver fallback, ADR 004)', () => {
  it('resolves a bare workspace package specifier directly to its source entry, no node_modules needed', () => {
    const packages = loadWorkspacePackages(wsRoot);
    const resolved = resolveWorkspaceSpecifier('@fixture/pkg-b', packages, wsRoot);
    expect(resolved).toBe(path.join(wsRoot, 'packages', 'pkg-b', 'src', 'index.ts'));
  });

  it('returns undefined for a specifier that names no known workspace package', () => {
    const packages = loadWorkspacePackages(wsRoot);
    expect(resolveWorkspaceSpecifier('left-pad', packages, wsRoot)).toBeUndefined();
  });
});
