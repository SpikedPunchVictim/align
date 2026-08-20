/**
 * Zero-coverage refusal heuristic (green≠correct guard (b), IMPLEMENTATION_PLAN.md Stage 4).
 *
 * v1 heuristic, stated honestly: a file is "covered" if any scanned test file imports it directly
 * or transitively within the graph — computable from the `DependencyGraph` the orchestrator already
 * builds, no separate coverage-instrumentation tool. This is a REACHABILITY proxy, not real
 * coverage: a test file that imports a module but never exercises the specific lines being changed
 * still counts as "covered." It catches the worst case (a file literally nothing imports from a
 * test) cheaply, at the cost of false confidence on files with imported-but-unexercised code.
 * Documented in the agent package README per the plan's requirement to state this plainly.
 *
 * **Why this returns a count and not a boolean (LEDGER D051).** `false` used to mean two completely
 * different things: "test files were scanned and none reach this file" — a real finding about the
 * file — and "this scan saw no test files at all", which is not a finding about the file at all.
 * The second happens for reasons that have nothing to do with the code under review: an `excludes`
 * pattern hiding the test tree, or a naming convention the pattern does not match. Reported from a
 * real monorepo on 2026-08-20 as twelve files across seven packages, every one refused with the
 * same sentence telling the user to write tests that already existed. Callers need the count to
 * tell those apart, so the count is what this returns [S-10].
 */
import { globMatch, type DependencyGraph, type RepoRelativePath } from '@spikedpunch/align-core';

/**
 * The test-file conventions align assumes when a repository has not said otherwise.
 *
 * Expressed in align's own glob dialect (`globMatch`), not a regex, so the one configurable form
 * and the default form go through the same matcher — and so `testFiles` in `align.config.ts` reads
 * like every other path-pattern export. These two reproduce the regex they replaced
 * (`/\.(test|spec)\./` against the whole path) exactly; `coverage-cannot-tell.test.ts` asserts the
 * equivalence file by file rather than leaving it to inspection, because a silent widening or
 * narrowing here changes the verdict for every repository that never configured anything.
 */
export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = ['**/*.test.*', '**/*.spec.*'];

export interface CoverageAssessment {
  /** Whether some scanned test file reaches `target` through the import graph. */
  readonly covered: boolean;
  /**
   * How many files in the scan matched the test-file patterns — **zero means align could not
   * look**, not that the target is untested. A caller that reports `covered: false` without
   * consulting this is making a claim about the file that the data does not support.
   */
  readonly scannedTestFileCount: number;
}

export function assessCoverage(
  target: RepoRelativePath,
  graph: DependencyGraph,
  testFilePatterns: readonly string[] = DEFAULT_TEST_FILE_PATTERNS,
): CoverageAssessment {
  const testFiles = graph.nodes.filter((n) => testFilePatterns.some((p) => globMatch(p, n.file))).map((n) => n.file);
  if (testFiles.length === 0) return { covered: false, scannedTestFileCount: 0 };

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
    if (current === target) return { covered: true, scannedTestFileCount: testFiles.length };
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return { covered: false, scannedTestFileCount: testFiles.length };
}

/**
 * Boolean view, kept for callers that genuinely only need the verdict.
 *
 * **Not for the refusal path.** `false` here still conflates "not covered" with "could not look" —
 * that is inherent to a boolean and is exactly what D051 was. `run.ts` uses `assessCoverage`.
 */
export function isFileCovered(
  target: RepoRelativePath,
  graph: DependencyGraph,
  testFilePatterns: readonly string[] = DEFAULT_TEST_FILE_PATTERNS,
): boolean {
  return assessCoverage(target, graph, testFilePatterns).covered;
}
