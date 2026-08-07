import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toComponentName } from '@spikedpunch/align-core';
import type { ComponentDefinitionIR } from '@spikedpunch/align-core';
import { TypeScriptScanner } from '../src/scanner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

function allComponent(): Record<string, ComponentDefinitionIR> {
  return { [toComponentName('all')]: { name: 'all', selector: { kind: 'glob', patterns: ['**'] }, empty: 'fail' } };
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
      [toComponentName('api')]: { name: 'api', selector: { kind: 'glob', patterns: ['src/api/**'] }, empty: 'fail' },
      [toComponentName('ui')]: { name: 'ui', selector: { kind: 'glob', patterns: ['src/ui/**'] }, empty: 'fail' },
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
      [toComponentName('orphan')]: { name: 'orphan', selector: { kind: 'glob', patterns: ['src/**'] }, empty: 'fail' },
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

describe('TypeScriptScanner — isBarrelReexport bit (ADR 016 public-surface inference)', () => {
  it('marks a bare `export * from` edge true and a named `export { a, b } from` edge false/absent', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: path.join(fixturesDir, 'exports'), components: allComponent(), excludes: [] });
    const reexportEdges = graph.edges.filter((e) => e.from === 'src/reexport.ts');
    expect(reexportEdges).toHaveLength(2);

    const toNamed = reexportEdges.find((e) => e.to === 'src/named.ts');
    const toDefault = reexportEdges.find((e) => e.to === 'src/default.ts');
    expect(toNamed?.isBarrelReexport).not.toBe(true);
    expect(toDefault?.isBarrelReexport).toBe(true);
  });

  it('leaves isBarrelReexport unset on plain import edges', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: path.join(fixturesDir, 'clean'), components: allComponent(), excludes: [] });
    expect(graph.edges[0]?.isBarrelReexport).toBeUndefined();
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
          [toComponentName('api')]: { name: 'api', selector: { kind: 'glob', patterns: ['src/api/**'] }, empty: 'fail' },
          [toComponentName('ui')]: { name: 'ui', selector: { kind: 'glob', patterns: ['src/ui/**'] }, empty: 'fail' },
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

describe('TypeScriptScanner — excludes now match core\'s glob dialect exactly (BUG #4)', () => {
  // `isExcludedPath` used to run a second, independent glob implementation
  // (`globLikeMatch`) that diverged from core's `globMatch` in three ways. It now delegates to
  // core's matcher directly, so exclude patterns must behave identically to component selectors.
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-scanner-excludes-test-'));
    fs.writeFileSync(path.join(dir, 'foo.generated.ts'), 'export const foo = 1;\n');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'export const keep = 1;\n');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'x.ts'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor', 'z.ts'), 'export const z = 1;\n');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a leading `**/` exclude also matches a root-level file (divergence 1: missing segment-boundary handling)', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({
      rootDir: dir,
      components: allComponent(),
      excludes: ['**/*.generated.ts', 'dist', 'vendor'],
    });
    expect(graph.nodes.map((n) => n.file)).not.toContain('foo.generated.ts');
    expect(graph.nodes.map((n) => n.file)).toContain('src/keep.ts');
  });

  it('a brace-group exclude pattern now works (divergence 2: no brace expansion)', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({
      rootDir: dir,
      components: allComponent(),
      excludes: ['{dist,build}/**', 'vendor'],
    });
    expect(graph.nodes.map((n) => n.file)).not.toContain('dist/x.ts');
    expect(graph.nodes.map((n) => n.file)).toContain('src/keep.ts');
  });

  it('a plain literal directory exclude still works (the directory-prefix arms kept alongside globMatch)', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({
      rootDir: dir,
      components: allComponent(),
      excludes: ['vendor', 'dist'],
    });
    expect(graph.nodes.map((n) => n.file)).not.toContain('vendor/z.ts');
    expect(graph.nodes.map((n) => n.file)).toContain('src/keep.ts');
  });
});

describe('TypeScriptScanner — loc no longer counts a phantom trailing line (BUG #5)', () => {
  // `text.split('\n')` yields a trailing empty-string element for any file ending in a newline
  // (essentially every file an editor or formatter writes), which used to be counted as a real
  // line. Table verified by hand against each case's real line count.
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-scanner-loc-test-'));
    fs.writeFileSync(path.join(dir, 'empty.ts'), '');
    fs.writeFileSync(path.join(dir, 'no-trailing-newline-one-line.ts'), 'const a = 1');
    fs.writeFileSync(path.join(dir, 'trailing-newline-one-line.ts'), 'const a = 1\n');
    fs.writeFileSync(path.join(dir, 'trailing-newline-three-lines.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n');
    fs.writeFileSync(path.join(dir, 'no-trailing-newline-three-lines.ts'), 'const a = 1\nconst b = 2\nconst c = 3');
    fs.writeFileSync(path.join(dir, 'blank-line-only.ts'), '\n');
    fs.writeFileSync(path.join(dir, 'two-blank-lines.ts'), '\n\n');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['empty.ts', 0],
    ['no-trailing-newline-one-line.ts', 1],
    ['trailing-newline-one-line.ts', 1],
    ['trailing-newline-three-lines.ts', 3],
    ['no-trailing-newline-three-lines.ts', 3],
    ['blank-line-only.ts', 1],
    ['two-blank-lines.ts', 2],
  ])('%s has loc = %i', async (file, expectedLoc) => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: dir, components: allComponent(), excludes: [] });
    const node = graph.nodes.find((n) => n.file === file);
    expect(node).toBeDefined();
    expect(node?.loc).toBe(expectedLoc);
  });

  it('does NOT match `wc -l` semantics for a file whose last line lacks a trailing newline', async () => {
    // `wc -l` counts newline characters, so it reports 2 for "const a = 1\nconst b = 2\nconst c = 3"
    // (no trailing \n). align reports 3 — the correct line count for a LOC metric. This test pins
    // that intentional divergence so it isn't "fixed" back toward `wc -l` later.
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: dir, components: allComponent(), excludes: [] });
    const node = graph.nodes.find((n) => n.file === 'no-trailing-newline-three-lines.ts');
    expect(node?.loc).toBe(3);
    expect(node?.loc).not.toBe(2); // 2 is what `wc -l` would report
  });
});
