import { describe, expect, it } from 'vitest';
import { toComponentName, toRepoRelativePath } from '../../src/index.js';
import type { DependencyGraph, DependencyGraphEdge, DependencyGraphNode, PackageEntrypoint } from '../../src/index.js';
import { inferSurface } from '../../src/surface/inferSurface.js';

const COMPONENT = toComponentName('pkg');

function node(file: string, exports: string[]): DependencyGraphNode {
  return { file: toRepoRelativePath(file), component: COMPONENT, loc: 10, exports, snippet: '' };
}

function edge(
  from: string,
  to: string,
  opts: { isBarrelReexport?: boolean; kind?: 'reexport' | 'type-only' | 'import' } = {},
): DependencyGraphEdge {
  return {
    from: toRepoRelativePath(from),
    to: toRepoRelativePath(to),
    specifier: `./${to}`,
    line: 1,
    kind: opts.kind ?? 'reexport',
    snippet: '',
    ...(opts.isBarrelReexport === undefined ? {} : { isBarrelReexport: opts.isBarrelReexport }),
  };
}

function graphOf(nodes: DependencyGraphNode[], edges: DependencyGraphEdge[]): DependencyGraph {
  return { nodes, edges, externalNodes: [], externalEdges: [], uncertain: [], scannedAt: 0 };
}

function declaredEntrypoint(file: string): PackageEntrypoint {
  return {
    confidence: 'declared',
    file: toRepoRelativePath(file),
    provenance: { source: 'package.json:exports', conditionPath: '.' },
  };
}

function inferredUniqueEntrypoint(file: string): PackageEntrypoint {
  return {
    confidence: 'inferred-unique',
    file: toRepoRelativePath(file),
    provenance: { source: 'convention', candidateCount: 1 },
  };
}

const inferredNoneEntrypoint: PackageEntrypoint = {
  confidence: 'inferred-none',
  file: null,
  provenance: { source: 'convention', candidateCount: 0 },
};

describe('inferSurface — direct exports (no barrel)', () => {
  it('collects an entrypoint file’s own exports at the entrypoint’s confidence, with no reachableVia hops', () => {
    const graph = graphOf([node('src/index.ts', ['foo', 'bar'])], []);
    const surface = inferSurface(graph, '@fixture/pkg', [declaredEntrypoint('src/index.ts')]);
    expect(surface.packageName).toBe('@fixture/pkg');
    expect(surface.uncertain).toEqual([]);
    expect(surface.exports.slice().sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
      { symbol: 'bar', declaredIn: toRepoRelativePath('src/index.ts'), reachableVia: [], confidence: 'declared' },
      { symbol: 'foo', declaredIn: toRepoRelativePath('src/index.ts'), reachableVia: [], confidence: 'declared' },
    ]);
  });
});

describe('inferSurface — named re-export does not leak the target’s other exports', () => {
  it('a named `export { foo } from` edge contributes nothing beyond what exports.ts already resolved', () => {
    // index.ts already has 'foo' in its own .exports (extractExportedSymbols resolves named
    // re-export lists itself) — the edge to math.ts is present (kind: 'reexport') but
    // isBarrelReexport is false/absent, so the walk must NOT recurse into math.ts and must NOT
    // pull in 'bar' (math.ts's other, non-re-exported symbol).
    const graph = graphOf(
      [node('src/index.ts', ['foo']), node('src/math.ts', ['foo', 'bar'])],
      [edge('src/index.ts', 'src/math.ts', { isBarrelReexport: false })],
    );
    const surface = inferSurface(graph, '@fixture/pkg', [declaredEntrypoint('src/index.ts')]);
    expect(surface.exports.map((e) => e.symbol)).toEqual(['foo']);
    expect(surface.exports[0]?.declaredIn).toBe(toRepoRelativePath('src/index.ts'));
    expect(surface.uncertain).toEqual([]);
  });
});

describe('inferSurface — bare `export *` transitive barrel walk', () => {
  it('recurses through a two-hop bare-star chain, unions symbols, and records the hop chain in reachableVia', () => {
    const graph = graphOf(
      [
        node('src/index.ts', []),
        node('src/sub/index.ts', []),
        node('src/sub/helper.ts', ['helperFn']),
      ],
      [
        edge('src/index.ts', 'src/sub/index.ts', { isBarrelReexport: true }),
        edge('src/sub/index.ts', 'src/sub/helper.ts', { isBarrelReexport: true }),
      ],
    );
    const surface = inferSurface(graph, '@fixture/pkg', [declaredEntrypoint('src/index.ts')]);
    expect(surface.uncertain).toEqual([]);
    expect(surface.exports).toEqual([
      {
        symbol: 'helperFn',
        declaredIn: toRepoRelativePath('src/sub/helper.ts'),
        reachableVia: [toRepoRelativePath('src/sub/index.ts'), toRepoRelativePath('src/sub/helper.ts')],
        confidence: 'declared',
      },
    ]);
  });

  it('does not propagate "default" through a bare star re-export (ECMAScript semantics)', () => {
    const graph = graphOf(
      [node('src/index.ts', []), node('src/impl.ts', ['default', 'named'])],
      [edge('src/index.ts', 'src/impl.ts', { isBarrelReexport: true })],
    );
    const surface = inferSurface(graph, '@fixture/pkg', [declaredEntrypoint('src/index.ts')]);
    expect(surface.exports.map((e) => e.symbol).sort()).toEqual(['named']);
  });

  it('an entrypoint-level (or earlier-resolved) name wins over a same-named symbol found deeper in the barrel', () => {
    const graph = graphOf(
      [node('src/index.ts', ['shared']), node('src/impl.ts', ['shared'])],
      [edge('src/index.ts', 'src/impl.ts', { isBarrelReexport: true })],
    );
    const surface = inferSurface(graph, '@fixture/pkg', [declaredEntrypoint('src/index.ts')]);
    expect(surface.exports).toHaveLength(1);
    expect(surface.exports[0]?.declaredIn).toBe(toRepoRelativePath('src/index.ts')); // entrypoint's own wins
  });
});

describe('inferSurface — barrel-cycle', () => {
  it('detects a self-referencing barrel cycle, names it, does not infinite-loop, and degrades confidence', () => {
    // a -> b -> a, both bare-star. First exercise of this marker per SPIKE_REPORT.md (never
    // observed in real repos across either validation round).
    const graph = graphOf(
      [node('src/a.ts', ['fromA']), node('src/b.ts', ['fromB'])],
      [
        edge('src/a.ts', 'src/b.ts', { isBarrelReexport: true }),
        edge('src/b.ts', 'src/a.ts', { isBarrelReexport: true }),
      ],
    );
    const surface = inferSurface(graph, '@fixture/pkg', [declaredEntrypoint('src/a.ts')]);
    expect(surface.uncertain).toEqual([{ file: toRepoRelativePath('src/a.ts'), reason: 'barrel-cycle' }]);
    // a's own direct export is still found, but the whole walk's confidence is downgraded because
    // the walk hit a cycle — "reachability is only as trustworthy as its weakest hop".
    const fromA = surface.exports.find((e) => e.symbol === 'fromA');
    expect(fromA?.confidence).toBe('inferred-none');
    // b's own export IS reached transitively (before the cycle triggers on revisiting a) —
    // also downgraded, same walk.
    const fromB = surface.exports.find((e) => e.symbol === 'fromB');
    expect(fromB?.confidence).toBe('inferred-none');
  });
});

describe('inferSurface — unresolvable-reexport', () => {
  it('names an edge whose target is not a scanned node, and degrades confidence for the whole walk', () => {
    // Second never-yet-fired marker (SPIKE_REPORT.md): a bare-star edge to a file outside the
    // scanned node set (e.g. a barrel to a dist-only path the scanner's own walk skipped).
    const graph = graphOf(
      [node('src/index.ts', ['direct'])],
      [edge('src/index.ts', 'dist/orphan.js', { isBarrelReexport: true })],
    );
    const surface = inferSurface(graph, '@fixture/pkg', [declaredEntrypoint('src/index.ts')]);
    expect(surface.uncertain).toEqual([{ file: toRepoRelativePath('src/index.ts'), reason: 'unresolvable-reexport' }]);
    expect(surface.exports).toEqual([
      { symbol: 'direct', declaredIn: toRepoRelativePath('src/index.ts'), reachableVia: [], confidence: 'inferred-none' },
    ]);
  });

  it('names a bare-star edge to a non-source-extension target distinctly (defensive — not reachable through a real scanner-produced graph, but the vocabulary must still be exercised)', () => {
    const graph = graphOf(
      [node('src/index.ts', ['direct'])],
      [edge('src/index.ts', 'src/styles.css', { isBarrelReexport: true })],
    );
    const surface = inferSurface(graph, '@fixture/pkg', [declaredEntrypoint('src/index.ts')]);
    expect(surface.uncertain).toEqual([
      { file: toRepoRelativePath('src/index.ts'), reason: 'non-source-reexport-target' },
    ]);
  });
});

describe('inferSurface — inferred-none entrypoint', () => {
  it('contributes zero entries and zero uncertain markers (package-level signal only)', () => {
    const graph = graphOf([], []);
    const surface = inferSurface(graph, '@fixture/pkg', [inferredNoneEntrypoint]);
    expect(surface.exports).toEqual([]);
    expect(surface.uncertain).toEqual([]);
    expect(surface.entrypoints).toEqual([inferredNoneEntrypoint]);
  });
});

describe('inferSurface — inferred-unique entrypoint, fully resolvable', () => {
  it('keeps inferred-unique confidence (not degraded) when the whole walk resolves cleanly', () => {
    const graph = graphOf(
      [node('index.ts', []), node('lib/helper.ts', ['thing'])],
      [edge('index.ts', 'lib/helper.ts', { isBarrelReexport: true })],
    );
    const surface = inferSurface(graph, '@nestjs/common', [inferredUniqueEntrypoint('index.ts')]);
    expect(surface.exports).toEqual([
      {
        symbol: 'thing',
        declaredIn: toRepoRelativePath('lib/helper.ts'),
        reachableVia: [toRepoRelativePath('lib/helper.ts')],
        confidence: 'inferred-unique',
      },
    ]);
  });
});

describe('inferSurface — multiple entrypoints (subpath exports), independently graded', () => {
  it('one broken subpath does not degrade a sibling subpath’s clean walk', () => {
    const graph = graphOf(
      [node('src/index.ts', ['root']), node('src/output_parsers/index.ts', ['Parser'])],
      [edge('src/index.ts', 'dist/missing.js', { isBarrelReexport: true })],
    );
    const surface = inferSurface(graph, '@langchain/core', [
      declaredEntrypoint('src/index.ts'),
      { confidence: 'declared', file: toRepoRelativePath('src/output_parsers/index.ts'), provenance: { source: 'package.json:exports', conditionPath: './output_parsers' } },
    ]);
    const root = surface.exports.find((e) => e.symbol === 'root');
    const parser = surface.exports.find((e) => e.symbol === 'Parser');
    expect(root?.confidence).toBe('inferred-none'); // its own walk hit the unresolvable hop
    expect(parser?.confidence).toBe('declared'); // sibling entrypoint's walk was clean
  });
});
