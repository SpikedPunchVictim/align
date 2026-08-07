/**
 * Iterative Tarjan strongly-connected-components — the SCC-finding algorithm is ported from
 * docs/evidence/kluster-spike/src/rules.ts (proven algorithm; recursive Tarjan blows the call
 * stack on large graphs, hence the explicit frame stack). Pure function: adjacency in, SCC groups
 * out, no I/O.
 *
 * `extractCycleChainNodes` below is NOT part of that provenance — it is align's own BFS,
 * written to replace a greedy walk that carried the same stranding defect as the kluster spike's
 * `extractCycleChain` (docs/evidence/kluster-spike/src/rules.ts:178). See BUG #9 in
 * .agents/research/2026-08-03-bug-hunt-full-codebase.md.
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

/**
 * The shortest cycle *through `scc[0]`* — not necessarily the shortest cycle in the SCC overall,
 * but guaranteed to close. A prior greedy walk here picked the first unseen in-SCC neighbor at
 * each step and could strand at a dead end with no edge back to `start`, returning a non-closed
 * "chain" that `evaluateNoCycles` rendered as a cycle anyway (BUG #9: measured 4.1% of
 * multi-node SCCs on real graphs). BFS cannot strand: in an SCC of size >= 2 every node is
 * mutually reachable, so `start` always has an in-SCC predecessor reachable from its own
 * successors, and BFS explores every reachable node before giving up.
 */
export function extractCycleChainNodes<T>(scc: readonly T[], adjacency: ReadonlyMap<T, readonly T[]>): T[] {
  const inScc = new Set(scc);
  const start = scc[0];
  if (start === undefined) return [];
  if (scc.length === 1) {
    // A single-node SCC is only a cycle at all if it has a self-edge (checked by the caller);
    // BFS below can never "revisit" a start node it never left, so this is a required special
    // case, not an optimization. Contract: exactly two elements on a self-loop — the caller
    // (evaluateNoCycles) builds hops from consecutive pairs and drops the violation on zero
    // hops, so a single-element return would silently lose it.
    const neighbors = adjacency.get(start) ?? [];
    return neighbors.includes(start) ? [start, start] : [start];
  }

  // Seed the queue with start's own in-SCC successors so the first hop is taken immediately —
  // a plain BFS from `start` would otherwise find the trivial zero-length "path" to itself.
  const parent = new Map<T, T>();
  const visited = new Set<T>([start]);
  const queue: T[] = [];
  for (const n of adjacency.get(start) ?? []) {
    if (!inScc.has(n) || visited.has(n)) continue;
    visited.add(n);
    parent.set(n, start);
    queue.push(n);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head];
    if (u === undefined) continue;
    const neighbors = adjacency.get(u) ?? []; // iterated in adjacency order for a deterministic result
    for (const v of neighbors) {
      if (!inScc.has(v)) continue;
      if (v === start) {
        // Reconstruct the path start -> ... -> u by walking parent pointers back from u.
        const path: T[] = [u];
        let node = u;
        for (;;) {
          const p = parent.get(node);
          if (p === undefined || p === start) break;
          path.push(p);
          node = p;
        }
        path.reverse();
        return [start, ...path, start];
      }
      if (visited.has(v)) continue;
      visited.add(v);
      parent.set(v, u);
      queue.push(v);
    }
  }
  // Unreachable for scc.length >= 2 in a real SCC (see the doc comment above) — kept as a safe
  // fallback rather than an assertion so a caller passing a non-SCC `scc` array degrades to a
  // single-node result instead of throwing.
  return [start];
}
