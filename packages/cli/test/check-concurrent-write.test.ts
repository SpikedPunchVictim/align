import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { baselineAccept } from '../src/commands/baseline.js';
import { lockPath } from '../src/align-lock.js';
import { readBaseline } from '../src/align-dir.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-concurrent-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

/** A lock that will not be broken: this test runner's own pid, so it is unmistakably alive. */
function plantLiveLock(rootDir: string): void {
  const file = lockPath(path.join(rootDir, '.align'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'align baseline accept', acquiredAt: new Date().toISOString() }),
  );
}

/**
 * ADR 030's refusal must not turn a green repository into a failed `align check`.
 *
 * **The regression this pins.** The first version of ADR 030 let the lock timeout and the token
 * mismatch escape as plain `Error`s. `runCheck` catches everything from `persistMovedBaseline` and
 * routes it to `reportCliError`, which returns 1 — and it does so BEFORE `emit` prints anything. So
 * a concurrent align (an MCP server, a second terminal, a parallel CI job) turned a green repo into
 * an exit-1 showing only an error line, which in CI is indistinguishable from a real violation.
 *
 * The codebase already contained the argument against that: `commands/baseline.ts` defers
 * move-transfers on a refused prune precisely because nothing is lost — "`align check`'s
 * `persistMovedBaseline` independently transfers the same moves, unconditionally, on every run."
 * The transfer is re-derived next run, and this run's verdict never depended on it, because the
 * in-memory store applied it before any of this.
 */
describe('align check tolerates a concurrent align rather than failing the run (ADR 030)', () => {
  it(
    'stays green and still prints results when the baseline write is blocked by another process',
    async () => {
      tmpDir = copyFixture('simple-app-violation');
      expect(await runCheck(tmpDir, { json: false })).toBe(1);
      await baselineAccept(tmpDir, undefined);
      expect(await runCheck(tmpDir, { json: false })).toBe(0);
      const before = readBaseline(tmpDir);
      expect(before).toHaveLength(1);

      // Rename the offending file, so this run has a real move-transfer to persist — without one,
      // `persistMovedBaseline` never writes and the test would pass in a world where the defect
      // still existed (shape S-05).
      fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));

      // Another align holds the lock and is not going to let go.
      plantLiveLock(tmpDir);
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const logs: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        logs.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let code: number;
      try {
        code = await runCheck(tmpDir, { json: true });
      } finally {
        process.stdout.write = originalWrite;
      }

      // THE ASSERTIONS THAT MATTER. Before the fix this was `1` with `logs` empty.
      expect(code).toBe(0);
      const payload = JSON.parse(logs.join('')) as { verdict: string };
      expect(payload.verdict).toBe('green');

      // The user is told, on stderr, that the transfer was deferred — silence would be its own
      // defect, since the baseline on disk no longer matches what this run reported.
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('the move-transfer was not persisted'));
    },
    // The lock wait is the production 10s; this test deliberately does not shorten it, because the
    // thing under test is what a user actually experiences when they collide with another align.
    20_000,
  );

  it('still FAILS the run for an error that is not a concurrency refusal', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));
    // Corrupt `.align/version.json`, which `writeBaseline`'s `alignVersion` stamp reads. This is the
    // hazard the original catch was written for, and it must still fail loudly — otherwise the fix
    // above would have traded one silent failure for another (shape S-04).
    fs.writeFileSync(path.join(tmpDir, '.align/version.json'), '{ not json', 'utf8');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runCheck(tmpDir, { json: false })).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('align check:'));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('the move-transfer was not persisted'));
  });
});
