import { describe, expect, it } from 'vitest';
import { computeDeepImportHits } from '../src/gates/deep-imports.js';
import { edge, externalEdge, graph, node, uncertainMarker } from './helpers.js';

describe('computeDeepImportHits (ADR 020)', () => {
  it('flags a subpath segment matching a default marker (dist)', () => {
    const g = graph(
      [node('src/a.ts', 'app')],
      [edge('src/a.ts', 'n8n-nodes-base/dist/nodes/Set/v2/helpers/interfaces', { specifier: 'n8n-nodes-base/dist/nodes/Set/v2/helpers/interfaces' })],
    );
    const hits = computeDeepImportHits(g);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      targetPackage: 'n8n-nodes-base',
      subpath: 'dist/nodes/Set/v2/helpers/interfaces',
      marker: 'dist',
    });
  });

  it('does not flag a bare package import with no subpath', () => {
    const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: 'lodash' })]);
    expect(computeDeepImportHits(g)).toHaveLength(0);
  });

  it('does not flag a subpath with no marker segment', () => {
    const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: 'lodash/fp' })]);
    expect(computeDeepImportHits(g)).toHaveLength(0);
  });

  describe('scoped-package parsing', () => {
    it('flags a scoped package deep import (@scope/name/dist/x)', () => {
      const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: '@scope/name/dist/x' })]);
      const hits = computeDeepImportHits(g);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ targetPackage: '@scope/name', subpath: 'dist/x', marker: 'dist' });
    });

    it('does NOT flag @scope/lib (marker in the package-name segment, not the subpath)', () => {
      const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: '@scope/lib' })]);
      expect(computeDeepImportHits(g)).toHaveLength(0);
    });

    it('does NOT flag a package literally named "lib" with no deep subpath', () => {
      const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: 'lib' })]);
      expect(computeDeepImportHits(g)).toHaveLength(0);
    });

    it('still flags a package named "lib" when it has a genuine deep subpath', () => {
      const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: 'lib/foo/dist/x' })]);
      const hits = computeDeepImportHits(g);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ targetPackage: 'lib', subpath: 'foo/dist/x', marker: 'dist' });
    });
  });

  describe('relative/absolute specifiers', () => {
    it('ignores a relative specifier even if it contains a marker segment', () => {
      const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'src/b.ts', { specifier: '../dist/helpers' })]);
      expect(computeDeepImportHits(g)).toHaveLength(0);
    });

    it('ignores an absolute specifier even if it contains a marker segment', () => {
      const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'src/b.ts', { specifier: '/dist/helpers' })]);
      expect(computeDeepImportHits(g)).toHaveLength(0);
    });
  });

  describe('allowlist suppression', () => {
    it('suppresses a hit matching an allowlist glob (typescript/lib/*)', () => {
      const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: 'typescript/lib/typescript' })]);
      expect(computeDeepImportHits(g, { allowlist: ['typescript/lib/*'] })).toHaveLength(0);
    });

    it('does not suppress a hit that does not match any allowlist glob', () => {
      const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: 'mocha/dist/foo' })]);
      expect(computeDeepImportHits(g, { allowlist: ['typescript/lib/*', 'mocha/lib/*'] })).toHaveLength(1);
    });
  });

  describe('the false-quiet fix (ADR 020 critical regression test)', () => {
    it('finds a hit that exists ONLY in graph.uncertain -- an edges-only reader would see nothing', () => {
      const g = graph([node('src/a.ts', 'app')], [], {
        uncertain: [uncertainMarker('src/a.ts', '@vscode/prompt-tsx/dist/base/promptElement')],
      });
      const hits = computeDeepImportHits(g);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        from: 'src/a.ts',
        targetPackage: '@vscode/prompt-tsx',
        subpath: 'dist/base/promptElement',
        marker: 'dist',
      });
    });

    it('also reads externalEdges (resolved external packages, not just internal edges)', () => {
      const g = graph([node('src/a.ts', 'app')], [], {
        edges: [externalEdge('src/a.ts', 'some-lib', { specifier: 'some-lib/internal/x' })],
      });
      const hits = computeDeepImportHits(g);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ targetPackage: 'some-lib', subpath: 'internal/x', marker: 'internal' });
    });
  });

  it('supports custom markers, overriding the default set entirely', () => {
    const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'x', { specifier: 'pkg/vendor/thing' })]);
    expect(computeDeepImportHits(g)).toHaveLength(0); // 'vendor' is not a default marker
    const hits = computeDeepImportHits(g, { markers: ['vendor'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.marker).toBe('vendor');
  });

  it('ranks hits by (targetPackage, subpath) frequency desc, then deterministic tie-breaks', () => {
    const g = graph(
      [node('src/a.ts', 'app'), node('src/b.ts', 'app'), node('src/c.ts', 'app')],
      [
        edge('src/a.ts', 'x', { specifier: 'rare-pkg/dist/x', line: 1 }),
        edge('src/b.ts', 'x', { specifier: 'common-pkg/dist/y', line: 1 }),
        edge('src/c.ts', 'x', { specifier: 'common-pkg/dist/y', line: 1 }),
      ],
    );
    const hits = computeDeepImportHits(g);
    expect(hits.map((h) => h.targetPackage)).toEqual(['common-pkg', 'common-pkg', 'rare-pkg']);
  });

  it('produces a deterministic order across repeated calls (no Date/random dependence)', () => {
    const g = graph(
      [node('src/a.ts', 'app'), node('src/b.ts', 'app')],
      [
        edge('src/a.ts', 'x', { specifier: 'zeta/dist/x', line: 1 }),
        edge('src/b.ts', 'x', { specifier: 'alpha/dist/x', line: 1 }),
      ],
    );
    const first = computeDeepImportHits(g);
    const second = computeDeepImportHits(g);
    expect(first).toEqual(second);
    expect(first.map((h) => h.targetPackage)).toEqual(['alpha', 'zeta']);
  });
});
