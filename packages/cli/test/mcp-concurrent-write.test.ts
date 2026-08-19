import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { lockPath } from '../src/align-lock.js';
import { readBaseline } from '../src/align-dir.js';
import { baselineAccept } from '../src/commands/baseline.js';
import { ConcurrentAlignWriteError } from '../src/concurrent-write-error.js';
import { connectedClient, copiedFixture, removeFixtureCopies, textOf } from './mcp-test-helpers.js';

// Hoisted so `mcp/server.ts` binds to the spy at import time. Only ONE test arms it; every other
// test in this file runs against the REAL writer, restored in `afterEach` — a spy left armed would
// quietly turn the lock test below into a test of the stub.
const real = vi.hoisted(() => ({ writeBaseline: undefined as undefined | ((...args: never[]) => unknown) }));
const { writeBaselineSpy } = vi.hoisted(() => ({ writeBaselineSpy: vi.fn() }));
vi.mock('../src/align-dir.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/align-dir.js')>();
  real.writeBaseline = actual.writeBaseline as unknown as (...args: never[]) => unknown;
  writeBaselineSpy.mockImplementation(actual.writeBaseline);
  return { ...actual, writeBaseline: writeBaselineSpy };
});

/**
 * LEDGER **D037** (bug hunt B7) — the MCP surface must degrade on a concurrent align exactly as the
 * two CLI arms do, instead of discarding a valid result.
 *
 * `ConcurrentAlignWriteError` exists for one reason, stated in its own doc comment: a concurrent
 * align "turned a green repository into a failed `check` showing only an error line, indistinguishable
 * in CI from a real violation." `commands/check.ts` routes it to a stderr note and prints the results
 * on BOTH arms (trusted and `--untrusted`). `mcp/server.ts`'s `freshCheck` performs the same
 * `writeBaseline` for the same move-transfer and had no such branch, so the tool handler's catch-all
 * turned it into `isError: true` — the agent gets an error string and NO verdict, no gates, no
 * violations, for a run that completed green.
 *
 * The transfer itself is not lost: the next call re-derives and re-persists it unconditionally, which
 * is the argument `commands/baseline.ts` already makes for deferring transfers on a refused prune.
 * What was lost was the answer.
 *
 * **This is the third time this exact function was the one that got missed.** Its own header says so
 * — `computeBaselineDebt` ("the third copy the first fix missed") and `withVersionSkew` (shipped on
 * `check`/`doctor`, silently absent here) preceded it. Shape [S-09]: one arm of a fix pinned, the
 * others left to memory.
 */

let tmpDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (real.writeBaseline !== undefined) writeBaselineSpy.mockImplementation(real.writeBaseline);
});
afterAll(removeFixtureCopies);

/** A lock that will not be broken: this test runner's own pid, so it is unmistakably alive. Same
 * planting helper as `check-concurrent-write.test.ts`, which pins the CLI half of this pair. */
function plantLiveLock(rootDir: string): void {
  const file = lockPath(path.join(rootDir, '.align'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'align baseline accept', acquiredAt: new Date().toISOString() }),
  );
}

interface Payload {
  readonly verdict: string;
  readonly gates: readonly { readonly gate: string }[];
  readonly advisories: readonly { readonly kind: string; readonly message: string }[];
}

describe('MCP align_check tolerates a concurrent align rather than failing the call (ADR 030)', () => {
  it(
    'returns the green verdict, and says the transfer was deferred, when the baseline write is blocked',
    async () => {
      tmpDir = copiedFixture('simple-app-violation');
      await baselineAccept(tmpDir, undefined);
      expect(readBaseline(tmpDir)).toHaveLength(1);

      // PREMISE [S-05]: without a real move-transfer `freshCheck` never calls `writeBaseline` at all,
      // and this test would pass in a world where the defect still existed. The rename is what makes
      // the write happen.
      fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));
      plantLiveLock(tmpDir);

      const client = await connectedClient(tmpDir);
      const result = await client.callTool({ name: 'align_check', arguments: {} });

      // THE ASSERTION THAT MATTERS. Before the fix: `isError: true` and a lock-timeout string, with
      // the entire check result thrown away.
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(textOf(result)) as Payload;
      expect(payload.verdict).toBe('green');
      expect(payload.gates.length).toBeGreaterThan(0);

      // Silence would be its own defect: the baseline on disk no longer matches what this call
      // reported, and an agent has no stderr to read — the CLI's note has to become payload data.
      const deferred = payload.advisories.filter((a) => a.kind === 'baseline-write-deferred');
      expect(deferred).toHaveLength(1);
      expect(deferred[0]?.message).toContain('next call');
    },
    // The production 10s lock wait, deliberately not shortened — same reasoning as the CLI twin.
    30_000,
  );

  it('align_violations degrades the same way — the two handlers each have their own catch', async () => {
    // INJECTED rather than provoked, and only here. The test above proves a real lock really does
    // produce this error through the real code path; what is left to check is that the SECOND tool's
    // catch routes it the same way, and provoking it again costs another 10s of production lock wait
    // for no new information about how the error arises. The seam is `writeBaseline` itself, so
    // everything between the tool handler and the refusal is still the real thing.
    //
    // `align_violations`' payload is `{violations, pagination}` — no verdict and no advisories — so
    // the assertion here is the one that matters for an agent: it still gets its answer.
    tmpDir = copiedFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));
    writeBaselineSpy.mockImplementation(() => {
      throw new ConcurrentAlignWriteError('align: .align/baseline.json changed while this command was running');
    });

    const client = await connectedClient(tmpDir);
    const result = await client.callTool({ name: 'align_violations', arguments: {} });

    expect(result.isError).toBeFalsy();
    // PREMISE [S-05]: the stub must actually have been reached. Without the rename above there is no
    // move-transfer, `writeBaseline` is never called, and this test would pass against the defect.
    expect(writeBaselineSpy).toHaveBeenCalled();
    expect(JSON.parse(textOf(result))).toHaveProperty('violations');
  });

  it('still reports a real failure as an error — the tolerance is for concurrency only', async () => {
    // Calibration [S-04]: a handler that swallowed everything would satisfy both tests above while
    // hiding genuine corruption. A corrupt `.align/version.json` is the hazard the original catch was
    // written for, and it must still reach the agent as an error.
    tmpDir = copiedFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));
    fs.writeFileSync(path.join(tmpDir, '.align/version.json'), '{ not json', 'utf8');

    const client = await connectedClient(tmpDir);
    const result = await client.callTool({ name: 'align_check', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not valid JSON');
  });
});
