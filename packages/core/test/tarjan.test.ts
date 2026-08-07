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

  // BUG #9: the prior greedy walk marked nodes "seen" and picked the first unseen in-SCC
  // neighbor at each step. On this adjacency it strands: scc[0] === 'n2', the walk goes
  // n2 -> n0, then greedily picks the dead-end 'n3' over the live 'n1', and n3's only
  // neighbor (n0) is already seen with no edge back to n2 — old chain was ['n2', 'n0', 'n3'],
  // last !== first. Every node here is mutually reachable (n0<->n3 via n0->n3->n0, and
  // n0->n1->n2->n0), so the SCC is genuinely one strongly-connected component of size 4.
  it('closes the loop for the measured strand case instead of stranding at a dead end', () => {
    const adjacency = adj({ n0: ['n3', 'n1'], n1: ['n2'], n2: ['n0'], n3: ['n0'] });
    const sccs = tarjanScc(adjacency);
    const scc = sccs.find((s) => s.length > 1);
    expect(scc).toBeDefined();
    if (scc === undefined) return;
    expect(scc[0]).toBe('n2'); // pin Tarjan's actual scc[0] so this test exercises the real strand case

    const chain = extractCycleChainNodes(scc, adjacency);
    expect(chain[0]).toBe(chain[chain.length - 1]); // closes
    for (let i = 0; i < chain.length - 1; i += 1) {
      const from = chain[i];
      const to = chain[i + 1];
      expect(adjacency.get(from as string)).toContain(to);
    }
  });

  // Property-style: enumerate every small digraph (3-4 nodes, all 2^(n*n) possible edge sets),
  // run the real tarjanScc, and assert every multi-node SCC's chain closes and every hop is a
  // real edge. This is the brute-force model that originally found 6,372 non-closing chains
  // out of 349,440 configurations for the old greedy walk (see the bug-hunt report, BUG #9).
  describe('property: every multi-node SCC produces a closed chain of real edges', () => {
    function* allAdjacencies(nodes: readonly string[]): Generator<Map<string, string[]>> {
      const pairs: Array<[string, string]> = [];
      for (const from of nodes) for (const to of nodes) if (from !== to) pairs.push([from, to]);
      const total = 2 ** pairs.length;
      for (let mask = 0; mask < total; mask += 1) {
        const map = new Map<string, string[]>(nodes.map((n) => [n, []]));
        for (let bit = 0; bit < pairs.length; bit += 1) {
          if ((mask & (1 << bit)) === 0) continue;
          const pair = pairs[bit];
          if (pair === undefined) continue;
          const [from, to] = pair;
          map.get(from)?.push(to);
        }
        yield map;
      }
    }

    for (const nodes of [['a', 'b', 'c'], ['a', 'b', 'c', 'd']] as const) {
      it(`holds over all digraphs on ${nodes.length} nodes`, () => {
        let multiNodeSccsChecked = 0;
        for (const adjacency of allAdjacencies(nodes)) {
          const sccs = tarjanScc(adjacency);
          for (const scc of sccs) {
            if (scc.length <= 1) continue;
            multiNodeSccsChecked += 1;
            const chain = extractCycleChainNodes(scc, adjacency);
            expect(chain[0]).toBe(chain[chain.length - 1]);
            for (let i = 0; i < chain.length - 1; i += 1) {
              const from = chain[i];
              const to = chain[i + 1];
              expect(adjacency.get(from as string)).toContain(to);
            }
          }
        }
        expect(multiNodeSccsChecked).toBeGreaterThan(0);
      });
    }
  });
});
