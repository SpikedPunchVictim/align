import { describe, expect, it } from 'vitest';
import { toRepoRelativePath } from '@spikedpunch/align-core';
import { assessCoverage, DEFAULT_TEST_FILE_PATTERNS } from '../src/coverage.js';
import { edge, graph, node } from './helpers.js';

/**
 * LEDGER **D051** — "no test file reaches this file" and "this scan saw no test files at all" are
 * different findings, and the agent reported them with one message.
 *
 * `isFileCovered` returned `false` the moment `testFiles.length === 0`, so on a repository where the
 * scan observed no test files EVERY file was uncovered and every group escalated with:
 *
 *     zero test coverage — no scanned test file transitively imports this file
 *     (pass --allow-untested to override)
 *
 * Reported from a real monorepo on 2026-08-20: twelve files across seven packages, all with that
 * line, no group reaching DONE, and no agent session ever starting — the gate runs before
 * `fixProvider.proposeFix`, so nothing was planned or sent. The message reads as "tests were
 * scanned; none reach this file", which points the user at writing tests. If the real cause is that
 * `excludes` hides the test files, or that they are named `__tests__/Foo.ts` rather than
 * `Foo.test.ts`, the tests already exist and the fix is in the config — a different action
 * entirely, and the output could not distinguish the two.
 *
 * [S-10], absence treated as evidence: an empty test-file set is "I could not look", and the honest
 * answer to "is this file covered?" from a scan that saw no tests is *unknown*, not *no*.
 *
 * The refusal itself is unchanged — an unknown-coverage file is still refused by default, because
 * the gate exists so the agent does not edit code it cannot verify. What changes is that the reason
 * names which of the two situations occurred, and reports the number of test files the scan
 * actually saw so the user can tell without guessing.
 */

const covered = (target: string, g: ReturnType<typeof graph>, patterns?: readonly string[]) =>
  assessCoverage(toRepoRelativePath(target), g, patterns);

describe('assessCoverage separates "not covered" from "cannot tell" [D051]', () => {
  it('reports how many test files the scan actually saw', () => {
    const g = graph(
      [node('src/a.ts', 'core'), node('src/b.ts', 'core'), node('src/b.test.ts', 'core')],
      [edge('src/b.test.ts', 'src/b.ts')],
    );

    const result = covered('src/a.ts', g);

    expect(result.covered).toBe(false);
    // The number is the whole point: 1 here means "tests were scanned and none reach you", which is
    // a real finding about `src/a.ts`.
    expect(result.scannedTestFileCount).toBe(1);
  });

  it('a scan with no test files at all reports zero, not a verdict about the file', () => {
    const g = graph([node('src/a.ts', 'core')], []);

    const result = covered('src/a.ts', g);

    expect(result.covered).toBe(false);
    // Before the fix this was indistinguishable from the case above.
    expect(result.scannedTestFileCount).toBe(0);
  });

  it('still finds direct and transitive coverage [S-04]', () => {
    // Calibration: the reachability walk is unchanged, and a fix that broke it would make every
    // file "uncovered" — which is exactly the symptom being fixed, arrived at from the other side.
    const direct = graph([node('src/a.ts', 'core'), node('src/a.test.ts', 'core')], [edge('src/a.test.ts', 'src/a.ts')]);
    expect(covered('src/a.ts', direct).covered).toBe(true);

    const transitive = graph(
      [node('src/a.ts', 'core'), node('src/helper.ts', 'core'), node('src/a.spec.ts', 'core')],
      [edge('src/a.spec.ts', 'src/helper.ts'), edge('src/helper.ts', 'src/a.ts')],
    );
    expect(covered('src/a.ts', transitive).covered).toBe(true);
  });
});

describe('the test-file pattern is configurable [D051]', () => {
  it('a repo whose tests live in __tests__/ can say so', () => {
    // The hardcoded pattern was `/\.(test|spec)\./`, so `__tests__/a.ts` was invisible and the file
    // it tests reported zero coverage. `isFileCovered` already ACCEPTED a pattern parameter — no
    // caller ever passed one, which is the sharper version of the defect: the seam existed and was
    // wired to nothing.
    const g = graph(
      [node('src/a.ts', 'core'), node('src/__tests__/a.ts', 'core')],
      [edge('src/__tests__/a.ts', 'src/a.ts')],
    );

    expect(covered('src/a.ts', g).covered).toBe(false); // default patterns do not know this layout
    expect(covered('src/a.ts', g, ['**/__tests__/**']).covered).toBe(true);
    expect(covered('src/a.ts', g, ['**/__tests__/**']).scannedTestFileCount).toBe(1);
  });

  it('accepts several patterns, and an e2e suite counts when declared', () => {
    const g = graph(
      [node('src/a.ts', 'core'), node('e2e/a.e2e.ts', 'core')],
      [edge('e2e/a.e2e.ts', 'src/a.ts')],
    );

    expect(covered('src/a.ts', g, ['**/*.test.*', '**/*.e2e.*']).covered).toBe(true);
  });

  it('the defaults reproduce the behaviour of the regex they replaced [S-04]', () => {
    // The old default was the regex /\.(test|spec)\./ against the whole path. Anything the new
    // glob defaults classify differently is a silent behaviour change for every existing repo, so
    // the equivalence is asserted rather than assumed.
    const g = graph(
      [
        node('src/a.test.ts', 'core'),
        node('src/a.spec.tsx', 'core'),
        node('deep/nested/dir/b.test.js', 'core'),
        node('root.test.ts', 'core'),
        node('src/nottest.ts', 'core'),
        node('src/testing.ts', 'core'),
      ],
      [],
    );
    const oldRegex = /\.(test|spec)\./;

    for (const n of g.nodes) {
      const byOld = oldRegex.test(n.file);
      const byNew = DEFAULT_TEST_FILE_PATTERNS.some((p) => matchesForTest(p, n.file));
      expect(byNew, `${n.file}: old=${byOld} new=${byNew}`).toBe(byOld);
    }
  });
});

/** Uses core's own matcher, the one `assessCoverage` uses — never a second implementation
 * (BUG #4's lesson). */
function matchesForTest(pattern: string, file: string): boolean {
  const g = graph([node(file, 'core')], []);
  return assessCoverage(toRepoRelativePath(file), g, [pattern]).scannedTestFileCount === 1;
}
