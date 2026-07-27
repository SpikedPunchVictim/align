import { describe, expect, it } from 'vitest';
import { computeUngovernedEdgeGaps } from '../src/gates/ungoverned-edges.js';
import { toComponentName } from '../src/types/branded.js';
import type { ComponentDefinitionIR, RuleIR, RulesetIR } from '../src/types/ir.js';
import { edge, graph, node } from './helpers.js';

const cname = toComponentName;

function comp(): ComponentDefinitionIR {
  return { name: '', selector: { kind: 'glob', patterns: ['**'] }, empty: 'fail' };
}

function ruleset(componentNames: readonly string[], rules: RuleIR[] = []): RulesetIR {
  const components: Record<string, ComponentDefinitionIR> = {};
  for (const name of componentNames) components[name] = comp();
  return { irVersion: '1', components, rules };
}

function noDep(from: string, to: string): RuleIR {
  return { kind: 'arch.no-dependency', id: `nodep:${from}->${to}`, from: cname(from), to: cname(to), provenance: {} };
}

function layers(layer: string, canDependOn: string[]): RuleIR {
  return {
    kind: 'arch.layers',
    id: `layers:${layer}`,
    layers: [{ layer: cname(layer), canDependOn: canDependOn.map(cname) }],
    provenance: {},
  };
}

describe('computeUngovernedEdgeGaps (ADR 019 Mode 2)', () => {
  it('reports a gap for a component pair with an import edge and no covering rule', () => {
    const g = graph(
      [node('apiPlugins/a.ts', 'apiPlugins'), node('apiDb/b.ts', 'apiDb')],
      [edge('apiPlugins/a.ts', 'apiDb/b.ts')],
    );
    const rs = ruleset(['apiPlugins', 'apiDb']);
    const gaps = computeUngovernedEdgeGaps(g, rs);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: 'apiPlugins', to: 'apiDb', edgeWeight: 1, fanIn: 1, bidirectional: false });
  });

  it('does not report a pair covered by an arch.no-dependency rule in the same direction', () => {
    const g = graph(
      [node('api/a.ts', 'api'), node('ui/b.ts', 'ui')],
      [edge('api/a.ts', 'ui/b.ts')],
    );
    const rs = ruleset(['api', 'ui'], [noDep('api', 'ui')]);
    expect(computeUngovernedEdgeGaps(g, rs)).toHaveLength(0);
  });

  it('does not report a pair covered by an arch.no-dependency rule in the OPPOSITE direction (unordered pair coverage)', () => {
    const g = graph(
      [node('api/a.ts', 'api'), node('ui/b.ts', 'ui')],
      [edge('api/a.ts', 'ui/b.ts')],
    );
    // Rule forbids ui -> api, but the ADR's governed computation treats either direction as
    // covering the pair {api, ui} — the boundary has already been decided on, even though the
    // actual edge direction observed is the allowed one.
    const rs = ruleset(['api', 'ui'], [noDep('ui', 'api')]);
    expect(computeUngovernedEdgeGaps(g, rs)).toHaveLength(0);
  });

  it('does not report a pair where the SOURCE component has an arch.layers rule (its outbound set is fully enumerated)', () => {
    const g = graph(
      [node('apiDomain/a.ts', 'apiDomain'), node('apiDb/b.ts', 'apiDb')],
      [edge('apiDomain/a.ts', 'apiDb/b.ts')],
    );
    const rs = ruleset(['apiDomain', 'apiDb'], [layers('apiDomain', ['apiDb'])]);
    expect(computeUngovernedEdgeGaps(g, rs)).toHaveLength(0);
  });

  it('DOES report an edge whose TARGET (not source) has an arch.layers rule — layers constrains only the layer’s OUTBOUND edges, so an inbound edge from an unruled source is still an undecided boundary', () => {
    const g = graph(
      [node('apiDomain/a.ts', 'apiDomain'), node('apiDb/b.ts', 'apiDb')],
      [edge('apiDomain/a.ts', 'apiDb/b.ts')],
    );
    // apiDb has a layers rule (its outbound set is enumerated), but nothing constrains what may
    // IMPORT apiDb — apiDomain -> apiDb is an unreviewed boundary. (Directional coverage fix, #7:
    // an earlier symmetric version wrongly suppressed this, hiding partial-layering retrofit gaps.)
    const rs = ruleset(['apiDomain', 'apiDb'], [layers('apiDb', [])]);
    const gaps = computeUngovernedEdgeGaps(g, rs);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: 'apiDomain', to: 'apiDb' });
  });

  it('the kluster ADR-019 demo shape: apiDomain->apiDb governed, apiPlugins->apiDb a gap', () => {
    const g = graph(
      [
        node('apiDomain/a.ts', 'apiDomain'),
        node('apiPlugins/a.ts', 'apiPlugins'),
        node('apiDb/b.ts', 'apiDb'),
      ],
      [edge('apiDomain/a.ts', 'apiDb/b.ts'), edge('apiPlugins/a.ts', 'apiDb/b.ts')],
    );
    const rs = ruleset(['apiDomain', 'apiPlugins', 'apiDb'], [layers('apiDomain', ['apiDb'])]);
    const gaps = computeUngovernedEdgeGaps(g, rs);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: 'apiPlugins', to: 'apiDb' });
  });

  it('excludes a self-loop (same component on both sides) even with no covering rule', () => {
    const g = graph(
      [node('api/a.ts', 'api'), node('api/b.ts', 'api')],
      [edge('api/a.ts', 'api/b.ts')],
    );
    expect(computeUngovernedEdgeGaps(g, ruleset(['api']))).toHaveLength(0);
  });

  it('excludes edges touching a file whose component is not declared in the ruleset (e.g. unmapped)', () => {
    const g = graph(
      [node('api/a.ts', 'api'), node('other/b.ts', 'unmapped')],
      [edge('api/a.ts', 'other/b.ts')],
    );
    expect(computeUngovernedEdgeGaps(g, ruleset(['api']))).toHaveLength(0);
  });

  it('excludes edges sourced from an explicit compositionRoots entry, regardless of governed status', () => {
    const g = graph(
      [node('api/a.ts', 'api'), node('apiDb/b.ts', 'apiDb')],
      [edge('api/a.ts', 'apiDb/b.ts')],
    );
    const rs = ruleset(['api', 'apiDb']);
    const gaps = computeUngovernedEdgeGaps(g, rs, new Set([cname('api')]));
    expect(gaps).toHaveLength(0);
  });

  it('does not exclude a compositionRoot as a TARGET — only as a source', () => {
    const g = graph(
      [node('apiPlugins/a.ts', 'apiPlugins'), node('api/b.ts', 'api')],
      [edge('apiPlugins/a.ts', 'api/b.ts')],
    );
    const rs = ruleset(['apiPlugins', 'api']);
    const gaps = computeUngovernedEdgeGaps(g, rs, new Set([cname('api')]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: 'apiPlugins', to: 'api' });
  });

  it('flags bidirectional when the reverse edge also exists and is itself ungoverned', () => {
    const g = graph(
      [node('a/x.ts', 'a'), node('b/y.ts', 'b')],
      [edge('a/x.ts', 'b/y.ts'), edge('b/y.ts', 'a/x.ts')],
    );
    const gaps = computeUngovernedEdgeGaps(g, ruleset(['a', 'b']));
    expect(gaps).toHaveLength(2);
    expect(gaps.every((gap) => gap.bidirectional)).toBe(true);
  });

  it('aggregates edge-weight as the import-site count for a from->to pair', () => {
    const g = graph(
      [node('api/a.ts', 'api'), node('api/b.ts', 'api'), node('core/c.ts', 'core')],
      [edge('api/a.ts', 'core/c.ts', { line: 1 }), edge('api/b.ts', 'core/c.ts', { line: 1 })],
    );
    const gaps = computeUngovernedEdgeGaps(g, ruleset(['api', 'core']));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.edgeWeight).toBe(2);
  });

  it('computes fan-in as the distinct-component count importing the target, repo-wide', () => {
    const g = graph(
      [node('a/x.ts', 'a'), node('b/x.ts', 'b'), node('c/x.ts', 'c'), node('target/t.ts', 'target')],
      [edge('a/x.ts', 'target/t.ts'), edge('b/x.ts', 'target/t.ts'), edge('c/x.ts', 'target/t.ts')],
    );
    const gaps = computeUngovernedEdgeGaps(g, ruleset(['a', 'b', 'c', 'target']));
    expect(gaps).toHaveLength(3);
    for (const gap of gaps) expect(gap.fanIn).toBe(3);
  });

  it('ranks gaps by edge-weight desc, then fan-in desc, for deterministic ordering', () => {
    const g = graph(
      [
        node('heavy/a.ts', 'heavy'),
        node('light/a.ts', 'light'),
        node('foundation/f.ts', 'foundation'),
        node('other/o.ts', 'other'),
      ],
      [
        edge('heavy/a.ts', 'foundation/f.ts', { specifier: './f1', line: 1 }),
        edge('heavy/a.ts', 'foundation/f.ts', { specifier: './f2', line: 2 }),
        edge('heavy/a.ts', 'foundation/f.ts', { specifier: './f3', line: 3 }),
        edge('light/a.ts', 'other/o.ts'),
      ],
    );
    const gaps = computeUngovernedEdgeGaps(g, ruleset(['heavy', 'light', 'foundation', 'other']));
    expect(gaps.map((gap) => `${gap.from}->${gap.to}`)).toEqual(['heavy->foundation', 'light->other']);
  });
});
