import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBaseline, readBaselineSnapshot, writeBaseline } from '../src/align-dir.js';
import { baselineAccept } from '../src/commands/baseline.js';

/**
 * LEDGER **D038** (bug hunt B9) — `align baseline accept` must not rewrite the provenance of an
 * entry that was already accepted.
 *
 * `store.accept` unconditionally `set`s every violation it is handed, and the CLI hands it EVERY
 * current violation, not just the unbaselined ones. So a re-run stamped `acceptedAt: Date.now()` and
 * `acceptedBy: 'manual'` over entries a person had accepted years earlier, under a different mode,
 * at exit 0, reporting "Accepted N violation(s)" for entries where nothing was decided. Measured
 * before the fix on `simple-app-violation`:
 *
 *     BEFORE  src/api/service.ts  accepted 2023-11-14T22:13:20.000Z (accept-existing)
 *     $ align baseline accept          ->  "Accepted 1 violation(s) into the baseline."   exit 0
 *     AFTER   src/api/service.ts  accepted 2026-08-19T22:29:12.644Z (manual)
 *
 * `acceptedAt` is the age of a piece of accepted debt — the only record of how long a violation has
 * been tolerated — and `align baseline show` prints both fields to the user. Restamping is not a
 * cosmetic loss: it resets that clock on every accept, so debt can never be seen to be old.
 *
 * **Shape [S-09], the other arm.** `align init` had exactly this defect, it was fixed, it was pinned
 * by `init-seed-provenance.test.ts`, and it ships a migration note describing the fix
 * (`migrations/notes.generated.ts`: "an entry a person had accepted manually in 2024 came back
 * looking as though `init` had accepted it moments ago"). `accept` — the command whose entire job is
 * provenance — was left alone, and nothing pinned it in either direction.
 *
 * **What must still be refreshed: `acceptedValue`.** The growth advisory tells the user in so many
 * words to "re-accept to record the new size" (`core/src/gates/advisories.ts`), so re-accepting IS
 * the documented remedy for a grown metric violation, and a fix that froze the whole entry would
 * break it. The third test here pins that; both variants were also built and driven through the real
 * CLI to measure what a user would actually experience, because the asymmetry reads as arbitrary
 * otherwise:
 *
 *     after the file grows 7 -> 37 lines     carried (frozen)   current (shipped)
 *     baseline accept                        still PRESENT      cleared
 *     baseline accept (again)                still PRESENT      cleared
 *     baseline prune --yes                   still PRESENT      cleared
 *
 * Carrying it leaves the advisory permanently unclearable by any command align ships. `acceptedAt`
 * survives under both variants, so the freeze buys nothing for debt age — only the escape hatch is
 * at stake.
 */

let tmpDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const repoRoot = path.resolve(here, '..', '..', '..');

function repo(name: string): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-accept-provenance-')));
  fs.cpSync(path.join(fixtures, name), dir, { recursive: true });
  // The fixture config imports `@spikedpunch/align-core/dsl` and `loadConfig` resolves it from the
  // TARGET repo. Without this link `baselineAccept` fails config load and writes nothing, and every
  // assertion below would pass against an untouched baseline — the way `init-rename-provenance`'s
  // first draft fooled itself.
  fs.mkdirSync(path.join(dir, 'node_modules', '@spikedpunch'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'packages', 'core'), path.join(dir, 'node_modules', '@spikedpunch', 'align-core'));
  return dir;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return fn();
}

/** Rewrites the seeded baseline to look like one a person accepted long ago under another mode —
 * the state the defect destroys, and one no command can produce in a single test run. */
function backdate(dir: string, acceptedAt: number, acceptedBy: 'init-seed' | 'accept-existing' | 'manual'): void {
  const { entries, token } = readBaselineSnapshot(dir);
  writeBaseline(
    dir,
    entries.map((e) => ({ ...e, acceptedAt, acceptedBy })),
    token,
  );
}

describe('align baseline accept preserves the provenance of entries it did not newly accept', () => {
  it('keeps acceptedAt and acceptedBy on an entry that was already in the baseline', async () => {
    const dir = repo('simple-app-violation');
    await quiet(() => baselineAccept(dir));
    backdate(dir, 1_700_000_000_000, 'accept-existing');

    expect(await quiet(() => baselineAccept(dir))).toBe(0);

    const after = readBaseline(dir);
    expect(after).toHaveLength(1);
    // The two assertions that failed before the fix, with `Date.now()` and `'manual'`.
    expect(after[0]?.acceptedAt).toBe(1_700_000_000_000);
    expect(after[0]?.acceptedBy).toBe('accept-existing');
  });

  it('still stamps a genuinely new violation — the command has to do its job', async () => {
    // Calibration [S-04]: a fix that preserved everything would satisfy the test above by never
    // writing at all. A violation align has never seen must be stamped now, as 'manual'.
    const dir = repo('simple-app-violation');
    const before = Date.now();

    expect(await quiet(() => baselineAccept(dir))).toBe(0);

    const after = readBaseline(dir);
    expect(after).toHaveLength(1);
    expect(after[0]?.acceptedBy).toBe('manual');
    expect(after[0]?.acceptedAt).toBeGreaterThanOrEqual(before);
  });

  it('still records the CURRENT size of a grown metric violation — re-accept is the documented remedy', async () => {
    // `advisories.ts` tells the user to "re-accept to record the new size" when a baselined file
    // grows past its accepted value. Freezing the whole entry would silently break that instruction
    // and leave the growth advisory firing forever with no way to clear it. This test failed on the
    // first draft of the fix, which preserved `acceptedValue` along with the timestamps.
    const dir = repo('simple-app-metric-violation');
    await quiet(() => baselineAccept(dir));
    const seeded = readBaseline(dir)[0];
    expect(seeded?.acceptedValue).toBeDefined();
    backdate(dir, 1_700_000_000_000, 'manual');

    const big = path.join(dir, 'src/big.ts');
    fs.appendFileSync(big, Array.from({ length: 30 }, (_, i) => `export const g${i} = ${i};`).join('\n') + '\n');

    expect(await quiet(() => baselineAccept(dir))).toBe(0);

    const after = readBaseline(dir)[0];
    expect(after?.acceptedValue).toBeGreaterThan(seeded?.acceptedValue ?? 0);
    // ...and the age of the debt is still the age of the debt. Recording a new size is not a new
    // decision to tolerate the violation; the violation has been tolerated since 2023.
    expect(after?.acceptedAt).toBe(1_700_000_000_000);
  });
});
