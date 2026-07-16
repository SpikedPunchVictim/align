import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
