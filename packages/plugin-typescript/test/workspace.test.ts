import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkspacePackages, resolveWorkspaceSpecifier } from '../src/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wsRoot = path.join(here, 'fixtures', 'pnpm-workspace');

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
