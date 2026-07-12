/**
 * Zero-coverage refusal heuristic (green≠correct guard (b), IMPLEMENTATION_PLAN.md Stage 4).
 *
 * v1 heuristic, stated honestly: a file is "covered" if any scanned test file (matching
 * `**\/*.{test,spec}.*`) imports it directly or transitively within the graph — computable from
 * the `DependencyGraph` the orchestrator already builds, no separate coverage-instrumentation
 * tool. This is a REACHABILITY proxy, not real coverage: a test file that imports a module but
 * never exercises the specific lines being changed still counts as "covered." It catches the
 * worst case (a file literally nothing imports from a test) cheaply, at the cost of false
 * confidence on files with imported-but-unexercised code. Documented in the agent package README
 * per the plan's requirement to state this plainly.
 */
import type { DependencyGraph, RepoRelativePath } from '@align/core';

const DEFAULT_TEST_FILE_PATTERN = /\.(test|spec)\./;

export function isFileCovered(
  target: RepoRelativePath,
  graph: DependencyGraph,
  testFilePattern: RegExp = DEFAULT_TEST_FILE_PATTERN,
): boolean {
  const testFiles = graph.nodes.filter((n) => testFilePattern.test(n.file)).map((n) => n.file);
  if (testFiles.length === 0) return false;

  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const visited = new Set<string>();
  const stack: string[] = [...testFiles];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}
