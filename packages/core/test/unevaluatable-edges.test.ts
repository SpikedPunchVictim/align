import { describe, expect, it } from 'vitest';
import { buildUnevaluatableEdgeAdvisories } from '../src/gates/advisories.js';
import { edge, graph, node } from './helpers.js';

/**
 * LEDGER **D052**'s safety net, and the reason it is a separate assertion from the resolution fix.
 *
 * An edge whose target is not a graph node is invisible to every rule: `evaluators.ts` opens each
 * loop with `if (fromNode === undefined || toNode === undefined) continue`. Nothing reported that.
 * D052 reached a real user as a green verdict on a repository with 40 emptied allowlists precisely
 * because the drop was silent — the resolution bug is the cause, but the SILENCE is what let it
 * survive to a release.
 *
 * Measured on align's own repository on 2026-08-20, after the D052 resolution fix: 820 edges still
 * pointed at non-nodes, bucketing into exactly two causes — `dist` (818) and `build` (2). The second
 * is D053: `packages/core/src/build/` holds 14 real source files and none is scanned, because the
 * default-excluded directory names are matched at ANY depth.
 *
 * So this advisory earns its place twice over: it reports the residue of the defect it was written
 * alongside, and it independently surfaced a second one nobody was looking for. A fix that only
 * repaired resolution would have left both silent.
 */

describe('edges that no rule can evaluate are reported [D052]', () => {
  it('reports an edge whose target was never scanned', () => {
    const g = graph([node('src/a.ts', 'app')], [edge('src/a.ts', 'libs/core/dist/index.d.ts')]);

    const advisories = buildUnevaluatableEdgeAdvisories(g);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('unevaluatable-edges');
    expect(advisories[0]?.message).toContain('1');
    // The target has to appear, or the user cannot act on it.
    expect(advisories[0]?.message).toContain('libs/core/dist/index.d.ts');
    // ...and the message must say what it MEANS, not just that it happened.
    expect(advisories[0]?.message).toMatch(/no rule|cannot be evaluated/i);
  });

  it('says nothing when every edge lands on a scanned node [S-04]', () => {
    // Calibration, and the one that matters most: this advisory will appear on real repositories,
    // and an advisory that fires on a healthy repo is noise that teaches people to ignore it.
    const g = graph(
      [node('src/a.ts', 'app'), node('src/b.ts', 'app')],
      [edge('src/a.ts', 'src/b.ts')],
    );

    expect(buildUnevaluatableEdgeAdvisories(g)).toEqual([]);
  });

  it('names the excluded directory when that is the cause, since that is the fix', () => {
    const g = graph(
      [node('src/a.ts', 'app')],
      [edge('src/a.ts', 'libs/core/dist/index.d.ts'), edge('src/a.ts', 'other/build/x.ts')],
    );

    const message = buildUnevaluatableEdgeAdvisories(g)[0]?.message ?? '';

    expect(message).toMatch(/dist/);
    expect(message).toMatch(/build/);
  });

  it('caps the sample but never the count', () => {
    // The count is the finding; the sample is a convenience. Truncating the count would understate
    // a scan hole, which is the class of lie this whole advisory exists to prevent.
    const edges = Array.from({ length: 40 }, (_, i) => edge('src/a.ts', `libs/core/dist/f${i}.d.ts`));
    const g = graph([node('src/a.ts', 'app')], edges);

    const message = buildUnevaluatableEdgeAdvisories(g)[0]?.message ?? '';

    expect(message).toContain('40');
    expect((message.match(/libs\/core\/dist\/f\d+\.d\.ts/g) ?? []).length).toBeLessThanOrEqual(5);
  });

  it('external edges are not affected — they have no file target by design [S-04]', () => {
    // `externalEdges` live in their own collection and are evaluated against `externalNodes`.
    // Sweeping them in here would fire on every repository that imports anything from npm.
    const g = graph([node('src/a.ts', 'app')], []);

    expect(buildUnevaluatableEdgeAdvisories(g)).toEqual([]);
  });
});
