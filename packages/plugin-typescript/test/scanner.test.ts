import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toComponentName } from '@align/core';
import type { ComponentDefinitionIR } from '@align/core';
import { TypeScriptScanner } from '../src/scanner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

function allComponent(): Record<string, ComponentDefinitionIR> {
  return { [toComponentName('all')]: { name: 'all', selector: { kind: 'glob', patterns: ['**'] }, allowEmpty: false } };
}

describe('TypeScriptScanner — clean fixture', () => {
  it('produces a graph with no edges between unrelated files and no uncertainty', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({
      rootDir: path.join(fixturesDir, 'clean'),
      components: allComponent(),
      excludes: [],
    });
    expect(graph.nodes.map((n) => n.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: 'src/b.ts', to: 'src/a.ts', kind: 'import' });
    expect(graph.uncertain).toHaveLength(0);
  });
});

describe('TypeScriptScanner — probe-violation fixture', () => {
  it('records the seeded cross-boundary edge with exact file/line/specifier', async () => {
    const scanner = new TypeScriptScanner();
    const components: Record<string, ComponentDefinitionIR> = {
      [toComponentName('api')]: { name: 'api', selector: { kind: 'glob', patterns: ['src/api/**'] }, allowEmpty: false },
      [toComponentName('ui')]: { name: 'ui', selector: { kind: 'glob', patterns: ['src/ui/**'] }, allowEmpty: false },
    };
    const graph = await scanner.scan({ rootDir: path.join(fixturesDir, 'probe-violation'), components, excludes: [] });
    const violatingEdge = graph.edges.find((e) => e.from === 'src/api/service.ts');
    expect(violatingEdge).toBeDefined();
    expect(violatingEdge?.to).toBe('src/ui/component.ts');
    expect(violatingEdge?.line).toBe(2);
    expect(violatingEdge?.specifier).toBe('../ui/component.js');

    const apiNode = graph.nodes.find((n) => n.file === 'src/api/service.ts');
    const uiNode = graph.nodes.find((n) => n.file === 'src/ui/component.ts');
    expect(apiNode?.component).toBe('api');
    expect(uiNode?.component).toBe('ui');
  });
});

describe('TypeScriptScanner — cycle fixture', () => {
  it('records both directions of the a<->b import cycle as edges', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: path.join(fixturesDir, 'cycle'), components: allComponent(), excludes: [] });
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.some((e) => e.from === 'src/a.ts' && e.to === 'src/b.ts')).toBe(true);
    expect(graph.edges.some((e) => e.from === 'src/b.ts' && e.to === 'src/a.ts')).toBe(true);
  });
});

describe('TypeScriptScanner — orphaned-package fixture', () => {
  it('classifies files by path-prefix component even with no pnpm-workspace.yaml at all', async () => {
    const scanner = new TypeScriptScanner();
    const components: Record<string, ComponentDefinitionIR> = {
      [toComponentName('orphan')]: { name: 'orphan', selector: { kind: 'glob', patterns: ['src/**'] }, allowEmpty: false },
    };
    const graph = await scanner.scan({ rootDir: path.join(fixturesDir, 'orphaned-package'), components, excludes: [] });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.component).toBe('orphan');
  });
});

describe('TypeScriptScanner — pnpm-workspace fixture (ADR 004 non-negotiable)', () => {
  const wsRoot = path.join(fixturesDir, 'pnpm-workspace');
  const nodeModulesDir = path.join(wsRoot, 'node_modules', '@fixture');
  const symlinkPath = path.join(nodeModulesDir, 'pkg-b');
  const realPkgDir = path.join(wsRoot, 'packages', 'pkg-b');

  beforeAll(() => {
    // pnpm workspaces install inter-package dependencies as real symlinks through
    // node_modules — created here at test time (rather than committed) since node_modules/
    // is gitignored repo-wide. This is the exact structural trap ADR 004 fixes: a naive
    // `path.includes('node_modules')` classification would misclassify the resulting edge as
    // external and silently drop it (spike: 898 edges, ~11% of kluster's graph).
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    if (fs.existsSync(symlinkPath)) fs.rmSync(symlinkPath, { force: true });
    fs.symlinkSync(realPkgDir, symlinkPath, 'dir');
  });

  afterAll(() => {
    fs.rmSync(path.join(wsRoot, 'node_modules'), { recursive: true, force: true });
  });

  it('classifies the cross-package edge as internal via realpath, not external via the symlink path', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: wsRoot, components: allComponent(), excludes: [] });
    const crossPackageEdge = graph.edges.find((e) => e.from === 'packages/pkg-a/src/index.ts');
    expect(crossPackageEdge).toBeDefined();
    expect(crossPackageEdge?.to).toBe('packages/pkg-b/src/index.ts');
    expect(crossPackageEdge?.specifier).toBe('@fixture/pkg-b');
  });
});

describe('TypeScriptScanner — extension coverage (.mjs/.cjs/.mts/.cts, Stage 5 infra)', () => {
  it('scans all four extensions as nodes and resolves same-flavor relative imports as edges', async () => {
    const scanner = new TypeScriptScanner();
    const g = await scanner.scan({ rootDir: path.join(fixturesDir, 'extensions'), components: allComponent(), excludes: [] });
    const files = g.nodes.map((n) => n.file).sort();
    expect(files).toEqual(['src/a.mjs', 'src/b.mjs', 'src/c.cjs', 'src/d.cjs', 'src/e.mts', 'src/f.mts', 'src/g.cts', 'src/h.cts']);

    expect(g.edges.some((e) => e.from === 'src/b.mjs' && e.to === 'src/a.mjs')).toBe(true);
    expect(g.edges.some((e) => e.from === 'src/d.cjs' && e.to === 'src/c.cjs')).toBe(true);
    expect(g.edges.some((e) => e.from === 'src/f.mts' && e.to === 'src/e.mts')).toBe(true);
    expect(g.edges.some((e) => e.from === 'src/h.cts' && e.to === 'src/g.cts')).toBe(true);
    expect(g.uncertain).toHaveLength(0);
  });
});

describe('TypeScriptScanner — external-package retention (Stage 5 infra: previously discarded at scanner.ts:228)', () => {
  const wsRoot = path.join(fixturesDir, 'external-imports');
  const pkgDir = path.join(wsRoot, 'node_modules', 'left-pad');

  beforeAll(() => {
    // A tiny real npm-shaped package, created at test time (node_modules is gitignored repo-wide,
    // same convention as the pnpm-workspace fixture above) so `ts.resolveModuleName` classifies
    // it 'external' via a real resolution rather than 'unresolved' (no install).
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = function leftPad() {};\n');
  });

  afterAll(() => {
    fs.rmSync(path.join(wsRoot, 'node_modules'), { recursive: true, force: true });
  });

  it('retains a Node builtin as a name-level external node, id-normalized regardless of the `node:` prefix', async () => {
    const scanner = new TypeScriptScanner();
    const g = await scanner.scan({ rootDir: wsRoot, components: allComponent(), excludes: [] });

    const builtinNode = g.externalNodes.find((n) => n.id === 'external:node:child_process');
    expect(builtinNode).toMatchObject({ packageName: 'child_process', isBuiltin: true });
    // a.ts uses `node:child_process`, b.ts uses bare `child_process` — one node, two edges.
    expect(g.externalNodes.filter((n) => n.packageName === 'child_process')).toHaveLength(1);
    const builtinEdges = g.externalEdges.filter((e) => e.to === 'external:node:child_process');
    expect(builtinEdges.map((e) => e.from).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(builtinEdges.every((e) => e.kind === 'import')).toBe(true);
  });

  it('retains an npm package as a name-level external node distinct from a builtin', async () => {
    const scanner = new TypeScriptScanner();
    const g = await scanner.scan({ rootDir: wsRoot, components: allComponent(), excludes: [] });

    const pkgNode = g.externalNodes.find((n) => n.id === 'external:left-pad');
    expect(pkgNode).toMatchObject({ packageName: 'left-pad', isBuiltin: false });
    const pkgEdge = g.externalEdges.find((e) => e.to === 'external:left-pad');
    expect(pkgEdge).toMatchObject({ from: 'src/a.ts', specifier: 'left-pad', kind: 'import' });
  });

  it('does not add resolved external specifiers to graph.uncertain — only the discard behavior changed (ADR 004)', async () => {
    const scanner = new TypeScriptScanner();
    const g = await scanner.scan({ rootDir: wsRoot, components: allComponent(), excludes: [] });
    expect(g.uncertain).toHaveLength(0);
  });

  it('leaves the file-to-file graph (nodes/edges) untouched — external retention is fully additive', async () => {
    const scanner = new TypeScriptScanner();
    const g = await scanner.scan({ rootDir: wsRoot, components: allComponent(), excludes: [] });
    // No internal edges exist in this fixture at all — both files only import externals.
    expect(g.edges).toHaveLength(0);
    expect(g.nodes.map((n) => n.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('TypeScriptScanner — rootDir under a symlinked ancestor (e.g. macOS /tmp -> /private/tmp)', () => {
  it('still classifies same-repo edges as internal, not external (regression: raw vs. realpath rootDir mismatch)', async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-scanner-symlink-test-'));
    try {
      fs.cpSync(path.join(fixturesDir, 'probe-violation'), dest, { recursive: true });
      // Sanity check this test actually exercises the symlink case on this OS/CI box; if the
      // temp dir isn't behind a symlink here, the assertion below is still valid, just less
      // interesting.
      const scanner = new TypeScriptScanner();
      const graph = await scanner.scan({
        rootDir: dest, // deliberately the RAW (non-realpath'd) path, as every real caller passes it
        components: {
          [toComponentName('api')]: { name: 'api', selector: { kind: 'glob', patterns: ['src/api/**'] }, allowEmpty: false },
          [toComponentName('ui')]: { name: 'ui', selector: { kind: 'glob', patterns: ['src/ui/**'] }, allowEmpty: false },
        },
        excludes: [],
      });
      const edge = graph.edges.find((e) => e.from === 'src/api/service.ts');
      expect(edge).toBeDefined();
      expect(edge?.to).toBe('src/ui/component.ts');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
