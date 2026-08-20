import { describe, expect, it } from 'vitest';
import { computeDeepImportHits } from '../src/gates/deep-imports.js';
import { graph, node } from './helpers.js';
import { toRepoRelativePath } from '../src/types/branded.js';

/**
 * LEDGER **D055** — the deep-import advisory flagged a stylesheet.
 *
 * Reported from a real ruleset: `import 'reactflow/dist/style.css'` produced
 *
 *     src/index.ts:1 imports 'reactflow/dist/style.css' — reaches past reactflow's public surface
 *     via 'dist' (subpath: dist/style.css).
 *
 * A CSS file has no public surface to reach past, and align already knows it is an asset: the
 * scanner classifies it `uncertain` with `reason: 'asset-specifier'` — measured on the reporter's
 * fixture, where the specifier appears in NO edge collection and exactly one uncertainty marker
 * carrying that reason.
 *
 * `computeDeepImportHits` iterates `graph.uncertain` and flattens each marker to
 * `{file, specifier, line}`, discarding the reason — so the one fact that answers the question is
 * thrown away one line before the question is asked. The check does not need new knowledge; it needs
 * to stop discarding what the scanner already determined.
 *
 * (The second half of that report — a package with NO `exports` map, where every subpath is public
 * under Node resolution — needs the target package's manifest and therefore I/O, which core does not
 * do. It is handled in the CLI; see `deep-import-no-exports.test.ts`.)
 */

const uncertain = (specifier: string, reason: string) => ({
  file: toRepoRelativePath('src/index.ts'),
  specifier,
  line: 1,
  reason: reason as never,
});

describe('deep-import does not flag assets [D055]', () => {
  it('an asset specifier is not a deep import', () => {
    const g = { ...graph([node('src/index.ts', 'app')], []), uncertain: [uncertain('reactflow/dist/style.css', 'asset-specifier')] };

    // Before the fix: one hit, claiming the stylesheet "reaches past reactflow's public surface".
    expect(computeDeepImportHits(g)).toEqual([]);
  });

  it('a non-asset uncertainty is still eligible [S-04]', () => {
    // Calibration, and the reason this filters on the REASON rather than on the file extension:
    // `graph.uncertain` is a legitimate source of deep-import occurrences. A specifier align could
    // not resolve for some other reason is still worth reporting, and dropping the whole collection
    // would silently narrow the check well past the defect.
    const g = {
      ...graph([node('src/index.ts', 'app')], []),
      uncertain: [uncertain('lodash/dist/internal', 'non-literal-dynamic-specifier')],
    };

    expect(computeDeepImportHits(g)).toHaveLength(1);
  });

  it('an ordinary deep import through a real edge is untouched [S-04]', () => {
    const g = {
      ...graph([node('src/index.ts', 'app')], []),
      externalEdges: [
        { from: toRepoRelativePath('src/index.ts'), to: 'external:lodash', specifier: 'lodash/dist/internal', line: 3, kind: 'import' as const },
      ],
    };

    const hits = computeDeepImportHits(g as never);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.specifier).toBe('lodash/dist/internal');
  });
});
