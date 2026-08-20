import { describe, expect, it } from 'vitest';
import { GateOrchestrator } from '../src/orchestrator.js';
import { InMemoryBaselineStore } from '../src/baseline/store.js';
import { noScanHistory } from '../src/baseline/scan-history.js';
import { StaticPluginRegistry, type LanguagePlugin } from '../src/plugin/registry.js';
import { defineProject } from '../src/dsl/index.js';
import { isRunComplete } from '../src/gates/advisories.js';
import { buildMcpCheckPayload } from '../src/payload/builder.js';
import type { CheckRun } from '../src/gates/types.js';
import type { ScanInput } from '../src/scanner.js';
import type { ManifestInventory, ManifestScanner } from '../src/types/manifest.js';
import { edge, graph, neverOnDisk, node } from './helpers.js';

/**
 * LEDGER **D043** (bug hunt FRAGILE F3, renumbered F2 in the phase plan) — an errored run must not
 * report `complete: true`.
 *
 * `untrustworthyScanScope()` (`orchestrator.ts`) exists because an errored run has no trustworthy
 * scan scope to report, and it forces FOUR sibling fields to their knows-nothing value on every
 * errored early return — `blindSpots`, `observedFiles`, `observedViolations`,
 * `componentMatchCounts`. `complete` is the fifth field answering the same question and it was not
 * in the set, because it is not a field on `CheckRun` at all: it is DERIVED, by `isRunComplete`,
 * from two axes that an errored run trivially satisfies. No `missing-dependencies` advisory fired
 * (nothing got far enough to look), and `ungroundedComponents` is `[]` (same reason) — so the
 * predicate concludes the run resolved everything it was asked to.
 *
 * Measured on a real repo, `simple-app` with one component selector rewritten to match no files:
 *
 *     $ align check --json ; echo "exit=$?"
 *     { "verdict": "error", "complete": true, "gates": [ ... "parse": "error" ... ],
 *       "violations": [], "advisories": [], "ungroundedComponents": [], "blindSpots": [], ... }
 *     exit=1
 *
 * `verdict: "error"` beside `complete: true` is a contradiction on the wire: the payload's own doc
 * comment defines the field as "`true` for a normal, dependency-complete scan", and this scan
 * evaluated no rule at all. Every other field in that payload is honestly zeroed; this one asserts
 * a completeness the run cannot back, which is the exact claim `untrustworthyScanScope`'s header
 * refuses to let the sibling fields make.
 *
 * **Fixed in the predicate, not in the payload**, and the four shapes below are why. Three errored
 * early returns in `check()` carry `untrustworthyScanScope()`; a fourth — a manifest scanner that
 * throws — errors the SECURITY gate while the architecture pipeline completes normally, so it
 * reaches the ordinary return with a real scan scope and `verdict: 'error'`. Patching the payload
 * builder would have covered all four too, but it would have left `isRunComplete` itself answering
 * "yes" for an errored run at its other consumers (ADR 023 tier 2, `packages/agent`), which is
 * [S-09] committed while fixing an S-09 instance.
 *
 * **Not a weakening of ADR 023's two tiers.** Tier 1 (`refuseIfRunErrored`, no override) runs before
 * tier 2 at both destructive call sites, so no errored run reaches the overridable guard today and
 * this changes nothing there — verified by reading both: `commands/baseline.ts` calls
 * `refuseIfRunErrored` and returns before `refuseIfRunIncomplete`, and `commands/init.ts` calls it
 * before BOTH of its `partitionAndRefuseIfBaselineWriteAtRisk` sites (the zero-violations reset and
 * the seed path). Cited by name, not line number, because the numbers move. What it changes
 * is what happens if a FUTURE destructive site calls only tier 2: before, an errored run sailed
 * through it; now it is refused, overridably. Strictly stronger in both directions.
 */

function fakePlugin(build: (input: ScanInput) => ReturnType<typeof graph>): LanguagePlugin {
  return { id: 'fake', fileMatch: ['**/*.ts'], scanner: { scan: async (input: ScanInput) => build(input) } };
}

const HEALTHY_GRAPH = (): ReturnType<typeof graph> =>
  graph([node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')], []);

function check(registry: StaticPluginRegistry, ruleset: ReturnType<typeof defineProject>, manifestScanner?: ManifestScanner): Promise<CheckRun> {
  const store = new InMemoryBaselineStore([], neverOnDisk, noScanHistory());
  const orchestrator =
    manifestScanner === undefined
      ? new GateOrchestrator(registry, ruleset, store)
      : new GateOrchestrator(registry, ruleset, store, new Map(), manifestScanner);
  return orchestrator.check({ rootDir: '/repo', excludes: [] });
}

const TWO_COMPONENTS = { api: 'application/api/**', ui: 'application/ui/**' };

/**
 * Every way `check()` can return `verdict: 'error'`, built through the orchestrator rather than
 * hand-written — a hand-built `CheckRun` would be asserting my own belief about what an errored run
 * looks like, and the whole defect is that that shape is easy to get wrong [S-05].
 *
 * Four, not three: the first three are the early returns carrying `untrustworthyScanScope()`, and
 * the fourth reaches the NORMAL return with a real scan scope. A fix that keyed off the zeroed
 * fields instead of the verdict would pass the first three and miss the fourth.
 */
const ERRORED_RUNS: readonly { readonly name: string; readonly build: () => Promise<CheckRun> }[] = [
  {
    name: 'the scanner threw (parse gate error)',
    build: () =>
      check(
        new StaticPluginRegistry([
          fakePlugin(() => {
            throw new Error('scanner crashed');
          }),
        ]),
        defineProject({ components: TWO_COMPONENTS }),
      ),
  },
  {
    name: 'a declared component matched zero files (architecture gate error)',
    build: () =>
      check(
        new StaticPluginRegistry([fakePlugin(() => graph([node('application/api/a.ts', 'api')], []))]),
        defineProject({ components: TWO_COMPONENTS }),
      ),
  },
  {
    name: 'a rule names a component that does not exist (architecture gate error)',
    build: () => {
      const ruleset = defineProject({ components: TWO_COMPONENTS, rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)] });
      const stale = {
        ...ruleset,
        rules: [...ruleset.rules, { kind: 'arch.no-dependency', id: 'stale-rule', from: 'ghost', to: 'ui', provenance: {} }],
      } as typeof ruleset;
      return check(new StaticPluginRegistry([fakePlugin(HEALTHY_GRAPH)]), stale);
    },
  },
  {
    name: 'the manifest scanner threw (security gate error, architecture pipeline unaffected)',
    build: () =>
      check(new StaticPluginRegistry([fakePlugin(HEALTHY_GRAPH)]), defineProject({ components: TWO_COMPONENTS }), {
        scan: (): ManifestInventory => {
          throw new Error('manifest scan blew up');
        },
      }),
  },
];

describe('an errored run is not a complete run [D043]', () => {
  for (const { name, build } of ERRORED_RUNS) {
    it(`isRunComplete is false when ${name}`, async () => {
      const run = await build();

      // PREMISE [S-05]: if this shape stops erroring, every assertion below passes vacuously and
      // the test becomes a green that measures nothing.
      expect(run.verdict).toBe('error');
      // ...and the two axes the predicate already had must BOTH be satisfied, or the run would be
      // incomplete for an unrelated reason and this test would not be about the verdict at all.
      expect(run.advisories.filter((a) => a.kind === 'missing-dependencies')).toEqual([]);
      expect(run.ungroundedComponents).toEqual([]);

      expect(isRunComplete(run)).toBe(false);
    });

    it(`the MCP payload reports complete: false when ${name}`, async () => {
      const payload = buildMcpCheckPayload(await build());

      expect(payload.verdict).toBe('error');
      // Before the fix: `true`, beside a verdict of `error` and every sibling field zeroed.
      expect(payload.complete).toBe(false);
    });
  }

  it('a healthy run is still complete — the fix is not "always false" [S-04]', async () => {
    const run = await check(new StaticPluginRegistry([fakePlugin(HEALTHY_GRAPH)]), defineProject({ components: TWO_COMPONENTS }));

    expect(run.verdict).toBe('green');
    expect(isRunComplete(run)).toBe(true);
    expect(buildMcpCheckPayload(run).complete).toBe(true);
  });

  it('a RED run is still complete — a violation found is a scan that worked [S-04]', async () => {
    // The calibration that matters most: `red` is the ordinary outcome this tool exists to produce,
    // and conflating "found something" with "could not look" would make every violating repository
    // report an untrustworthy scan and trip ADR 023 tier 2 on every prune.
    const ruleset = defineProject({ components: TWO_COMPONENTS, rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)] });
    const registry = new StaticPluginRegistry([
      fakePlugin(() =>
        graph(
          [node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')],
          [edge('application/api/a.ts', 'application/ui/b.ts', { specifier: '../ui/b', line: 3 })],
        ),
      ),
    ]);
    const run = await check(registry, ruleset);

    expect(run.verdict).toBe('red');
    expect(isRunComplete(run)).toBe(true);
  });
});
