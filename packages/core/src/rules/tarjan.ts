/**
 * Iterative Tarjan strongly-connected-components — ported from docs/evidence/kluster-spike/src/rules.ts (proven
 * algorithm; recursive Tarjan blows the call stack on large graphs, hence the explicit frame
 * stack). Pure function: adjacency in, SCC groups out, no I/O.
 */
export function tarjanScc<T>(adjacency: ReadonlyMap<T, readonly T[]>): T[][] {
  let index = 0;
  const nodeIndex = new Map<T, number>();
  const lowLink = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const sccs: T[][] = [];

  interface Frame {
    readonly node: T;
    childIdx: number;
  }

  for (const root of adjacency.keys()) {
    if (nodeIndex.has(root)) continue;
    const frames: Frame[] = [{ node: root, childIdx: 0 }];
    nodeIndex.set(root, index);
    lowLink.set(root, index);
    index += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const neighbors = adjacency.get(frame.node) ?? [];

      if (frame.childIdx < neighbors.length) {
        const next = neighbors[frame.childIdx];
        frame.childIdx += 1;
        if (next === undefined) continue;
        if (!nodeIndex.has(next)) {
          nodeIndex.set(next, index);
          lowLink.set(next, index);
          index += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, childIdx: 0 });
        } else if (onStack.has(next)) {
          const nl = lowLink.get(frame.node) ?? 0;
          lowLink.set(frame.node, Math.min(nl, nodeIndex.get(next) ?? 0));
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        const pl = lowLink.get(parent.node) ?? 0;
        lowLink.set(parent.node, Math.min(pl, lowLink.get(frame.node) ?? 0));
      }
      if (lowLink.get(frame.node) === nodeIndex.get(frame.node)) {
        const scc: T[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          scc.push(popped);
          if (popped === frame.node) break;
        }
        sccs.push(scc);
      }
    }
  }
  return sccs;
}

/** Walk within the SCC from its first node until it revisits it, yielding one concrete cycle. */
export function extractCycleChainNodes<T>(scc: readonly T[], adjacency: ReadonlyMap<T, readonly T[]>): T[] {
  const inScc = new Set(scc);
  const start = scc[0];
  if (start === undefined) return [];
  if (scc.length === 1) {
    // A single-node SCC is only a cycle at all if it has a self-edge (checked by the caller);
    // the general walk below can never "revisit" a start node it never left, so this is a
    // required special case, not an optimization.
    const neighbors = adjacency.get(start) ?? [];
    return neighbors.includes(start) ? [start, start] : [start];
  }
  const chain: T[] = [start];
  const seen = new Set<T>([start]);
  let current = start;
  for (let i = 0; i < scc.length + 1; i += 1) {
    const neighbors: readonly T[] = adjacency.get(current) ?? [];
    if (current !== start && neighbors.includes(start)) {
      chain.push(start); // prefer closing the loop over wandering the SCC
      return chain;
    }
    const next = neighbors.find((n) => inScc.has(n) && !seen.has(n));
    if (next === undefined) break;
    chain.push(next);
    if (next === start) return chain;
    seen.add(next);
    current = next;
  }
  return chain; // partial chain (still informative) if a tidy loop was not found
}
