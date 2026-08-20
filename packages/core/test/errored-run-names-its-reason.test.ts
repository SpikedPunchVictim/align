import { describe, expect, it } from 'vitest';
import { GateOrchestrator } from '../src/orchestrator.js';
import { InMemoryBaselineStore } from '../src/baseline/store.js';
import { noScanHistory } from '../src/baseline/scan-history.js';
import { StaticPluginRegistry, type LanguagePlugin } from '../src/plugin/registry.js';
import { defineProject } from '../src/dsl/index.js';
import { describeErroredGates } from '../src/gates/advisories.js';
import { buildMcpCheckPayload } from '../src/payload/builder.js';
import type { CheckRun } from '../src/gates/types.js';
import type { ScanInput } from '../src/scanner.js';
import type { ManifestInventory } from '../src/types/manifest.js';
import { graph, neverOnDisk, node } from './helpers.js';

/**
 * LEDGER **D047** (found while measuring D043) — a machine-readable run that errored must say WHY.
 *
 * D043 made `align check --json` and the MCP payload stop claiming `complete: true` on an errored
 * run. Reading that same output showed the other half: the reason is nowhere. Measured, on a repo
 * with a component selector pointing at a path that does not exist:
 *
 *     $ align check --json ; echo "exit=$?"
 *     { "verdict": "error", "complete": false,
 *       "gates": [ { "gate": "parse", "status": "error", "violationCount": 0, "baselinedCount": 0 },
 *                  ... ],
 *       "violations": [], "advisories": [], ... }
 *     exit=1
 *     (stderr: empty)
 *
 * `GateResult.errorMessage` holds the diagnosis and the human surface prints it in full — six lines
 * naming the component, its selector, and the three remedies. The payload's gate projection drops
 * the field, and nothing puts it anywhere else, so a `--json` consumer gets exit 1 and no reason on
 * either stream. That is the CLI-best-practices rule this repo follows elsewhere ("errors are
 * actionable: context → problem → fix") holding on one surface and not its machine twin. [S-09].
 *
 * **The field was excluded deliberately, and the comment saying so was the thing to re-examine.**
 * `gates/types.ts` marked `errorMessage` "environmental, never LLM-facing", and ADR 007 bans
 * per-item text from PASSING gates for token economy. Neither argument survives contact: an errored
 * gate is not a passing gate, `advisories` already carry free prose into the same payload, and the
 * bound is one string per errored gate across at most three gates. The exclusion was a reasonable
 * default that nobody had priced.
 *
 * **One formatter, not a third copy.** `errored-run.ts` (ADR 023 tier 1) and `packages/agent`'s
 * refusal already built the identical `"${gate} gate: ${errorMessage}"` join independently. ADR 023
 * exists because five copies of a related asymmetry drifted; adding a third here and a fourth in
 * `mcp/server.ts` is how that happens. `describeErroredGates` is now the only implementation and all
 * four callers use it.
 */

function fakePlugin(build: (input: ScanInput) => ReturnType<typeof graph>): LanguagePlugin {
  return { id: 'fake', fileMatch: ['**/*.ts'], scanner: { scan: async (input: ScanInput) => build(input) } };
}

const HEALTHY = (): ReturnType<typeof graph> => graph([node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')], []);
const TWO_COMPONENTS = { api: 'application/api/**', ui: 'application/ui/**' };

function check(registry: StaticPluginRegistry, ruleset: ReturnType<typeof defineProject>, manifest?: ManifestInventory | 'throws'): Promise<CheckRun> {
  const store = new InMemoryBaselineStore([], neverOnDisk, noScanHistory());
  const scanner =
    manifest === 'throws'
      ? {
          scan: (): ManifestInventory => {
            throw new Error('manifest scan blew up');
          },
        }
      : undefined;
  const orchestrator =
    scanner === undefined
      ? new GateOrchestrator(registry, ruleset, store)
      : new GateOrchestrator(registry, ruleset, store, new Map(), scanner);
  return orchestrator.check({ rootDir: '/repo', excludes: [] });
}

const scannerThrows = (): Promise<CheckRun> =>
  check(
    new StaticPluginRegistry([
      fakePlugin(() => {
        throw new Error('scanner crashed on tsconfig.json');
      }),
    ]),
    defineProject({ components: TWO_COMPONENTS }),
  );

describe('the errored gate’s reason reaches the machine surface [D047]', () => {
  it('the payload carries errorMessage on the gate that errored', async () => {
    const run = await scannerThrows();

    // PREMISE [S-05]: the message must exist on the run, or the payload has nothing to carry and
    // this test would pass against a builder that dropped a field that was always undefined.
    expect(run.gates.find((g) => g.gate === 'parse')?.errorMessage).toContain('scanner crashed on tsconfig.json');

    const payload = buildMcpCheckPayload(run);

    // Before the fix: the gate projection was {gate, status, violationCount, baselinedCount} only,
    // so exit 1 with the reason on neither stdout nor stderr.
    const parse = payload.gates.find((g) => g.gate === 'parse');
    expect(parse?.errorMessage).toContain('scanner crashed on tsconfig.json');
  });

  it('carries it for a security-gate error too — the shape that keeps a real scan scope', async () => {
    const payload = buildMcpCheckPayload(await check(new StaticPluginRegistry([fakePlugin(HEALTHY)]), defineProject({ components: TWO_COMPONENTS }), 'throws'));

    expect(payload.gates.find((g) => g.gate === 'security')?.errorMessage).toContain('manifest scan blew up');
  });

  it('adds nothing to a gate that did not error [S-04]', async () => {
    // Calibration, and the ADR 007 constraint that made this field excluded in the first place: a
    // passing gate contributes counts only, never text. `errorMessage` must be absent, not empty.
    const payload = buildMcpCheckPayload(await check(new StaticPluginRegistry([fakePlugin(HEALTHY)]), defineProject({ components: TWO_COMPONENTS })));

    expect(payload.verdict).toBe('green');
    for (const gate of payload.gates) expect(gate).not.toHaveProperty('errorMessage');
  });
});

describe('describeErroredGates is the one formatter [D047]', () => {
  it('names each errored gate and its message', async () => {
    const described = describeErroredGates(await scannerThrows());

    expect(described).toContain('parse gate:');
    expect(described).toContain('scanner crashed on tsconfig.json');
  });

  it('still names the gate when it errored without a message', async () => {
    // A gate can error carrying no message, and a refusal reading "refusing to prune the baseline —"
    // with nothing after the dash helps nobody. Naming the gate is the part that survives.
    const run = await scannerThrows();
    const stripped: CheckRun = {
      ...run,
      // The KEY removed, not set to `undefined` — `exactOptionalPropertyTypes` distinguishes them,
      // and "the gate carried no message" is the absence, not a present undefined.
      gates: run.gates.map((g) => {
        if (g.status !== 'error') return g;
        const { errorMessage: _dropped, ...rest } = g;
        return rest;
      }),
    };

    expect(describeErroredGates(stripped)).toBe('parse gate: unknown error');
  });

  it('returns the empty string for a run with no errored gate', async () => {
    // The one case where empty is right: there is nothing to describe, and a caller that appends it
    // unconditionally must not get filler prose about an error that did not happen.
    expect(describeErroredGates(await check(new StaticPluginRegistry([fakePlugin(HEALTHY)]), defineProject({ components: TWO_COMPONENTS })))).toBe('');
  });
});
