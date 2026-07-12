import { describe, expect, it } from 'vitest';
import { extractCycleChainNodes, tarjanScc } from '../src/rules/tarjan.js';

function adj(pairs: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(pairs));
}

describe('tarjanScc', () => {
  it('finds no SCCs larger than 1 in a DAG', () => {
    const graph = adj({ a: ['b'], b: ['c'], c: [] });
    const sccs = tarjanScc(graph);
    expect(sccs.every((scc) => scc.length === 1)).toBe(true);
  });

  it('detects a self-loop as its own SCC', () => {
    const graph = adj({ a: ['a'] });
    const sccs = tarjanScc(graph);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toEqual(['a']);
  });

  it('detects a simple two-node cycle', () => {
    const graph = adj({ a: ['b'], b: ['a'] });
    const sccs = tarjanScc(graph);
    const multiNode = sccs.filter((scc) => scc.length > 1);
    expect(multiNode).toHaveLength(1);
    expect(new Set(multiNode[0])).toEqual(new Set(['a', 'b']));
  });

  it('detects a multi-node SCC (a->b->c->a) distinct from an unrelated DAG branch', () => {
    const graph = adj({ a: ['b'], b: ['c'], c: ['a'], d: ['a'] });
    const sccs = tarjanScc(graph);
    const cyclic = sccs.find((scc) => scc.length === 3);
    expect(cyclic).toBeDefined();
    expect(new Set(cyclic)).toEqual(new Set(['a', 'b', 'c']));
    const dScc = sccs.find((scc) => scc.includes('d'));
    expect(dScc).toEqual(['d']);
  });

  it('handles disconnected graphs with multiple independent cycles', () => {
    const graph = adj({ a: ['b'], b: ['a'], x: ['y'], y: ['x'], z: [] });
    const sccs = tarjanScc(graph);
    const multiNode = sccs.filter((scc) => scc.length > 1);
    expect(multiNode).toHaveLength(2);
  });
});

describe('extractCycleChainNodes', () => {
  it('closes the loop back to the start node', () => {
    const graph = adj({ a: ['b'], b: ['c'], c: ['a'] });
    const chain = extractCycleChainNodes(['a', 'b', 'c'], graph);
    expect(chain).toEqual(['a', 'b', 'c', 'a']);
  });

  it('handles a self-loop scc', () => {
    const graph = adj({ a: ['a'] });
    const chain = extractCycleChainNodes(['a'], graph);
    expect(chain[0]).toBe('a');
  });
});
