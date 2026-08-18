import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockPath, withAlignDirLock } from '../src/align-lock.js';

let dir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

/** The `.align` directory the lock lives in — this module takes that directory, not the repo
 * root, so that it need not import `align-dir.ts` and create a cycle (see its doc comment). */
function repo(): string {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-lock-')));
  return path.join(dir, '.align');
}

/** Plants a lock file as if another process held it. `pid` decides whether it looks alive:
 * `process.pid` is this test runner, which is emphatically alive. */
function plantLock(rootDir: string, holder: { pid: number; host?: string; ageMs?: number }): void {
  fs.mkdirSync(path.dirname(lockPath(rootDir)), { recursive: true });
  fs.writeFileSync(
    lockPath(rootDir),
    JSON.stringify({
      pid: holder.pid,
      host: holder.host ?? os.hostname(),
      command: 'align baseline prune',
      acquiredAt: new Date(Date.now() - (holder.ageMs ?? 0)).toISOString(),
    }),
  );
}

/** A pid that is almost certainly not running. Not guaranteed by POSIX, but 2^22-ish is above the
 * default pid_max on Linux and macOS, and the tests that use it assert "treated as dead" — a false
 * negative would make them fail loudly rather than pass wrongly. */
const DEAD_PID = 4_194_303;

describe('withAlignDirLock', () => {
  it('creates the lock while the body runs and removes it afterwards', () => {
    const d = repo();
    let seenDuring = false;

    const result = withAlignDirLock(d, 'align check', () => {
      seenDuring = fs.existsSync(lockPath(d));
      return 42;
    });

    expect(result).toBe(42);
    expect(seenDuring).toBe(true);
    expect(fs.existsSync(lockPath(d))).toBe(false);
  });

  it('releases the lock when the body throws, and propagates the original error', () => {
    const d = repo();

    expect(() =>
      withAlignDirLock(d, 'align check', () => {
        throw new Error('body exploded');
      }),
    ).toThrow('body exploded');

    // A lock leaked on the error path is worse than no lock: every later align in this repo blocks
    // for the full timeout and then reports a holder that never existed.
    expect(fs.existsSync(lockPath(d))).toBe(false);
  });

  it('propagates an EEXIST thrown by the BODY instead of mistaking it for lock contention', () => {
    const d = repo();
    // The bug this pins, caught while writing these tests: acquisition and execution shared one
    // `try`, so any error escaping the body was inspected for `EEXIST` — and the body here is a
    // filesystem write, which raises exactly that. The caller's error would be swallowed, the loop
    // would retry until the deadline, and the user would be told the lock timed out.
    fs.mkdirSync(d, { recursive: true }); // `d` is the .align dir, which nothing has created yet
    const collide = path.join(d, 'already-there');
    fs.writeFileSync(collide, 'x');

    expect(() =>
      withAlignDirLock(
        d,
        'align check',
        () => {
          fs.openSync(collide, 'wx'); // EEXIST, from the body
        },
        { waitTimeoutMs: 200, pollIntervalMs: 5 },
      ),
    ).toThrow(/EEXIST/);
    expect(fs.existsSync(lockPath(d))).toBe(false);
  });

  it('waits, then times out with a message naming the holder, when the lock is held by a LIVE process', () => {
    const d = repo();
    plantLock(d, { pid: process.pid }); // this very test runner: unambiguously alive

    expect(() => withAlignDirLock(d, 'align check', () => 'never', { waitTimeoutMs: 150, pollIntervalMs: 10 })).toThrow(
      /timed out after 0.15s .*align baseline prune.*pid \d+/s,
    );
    // Not broken: a live holder's lock must survive. Breaking it is the one action here that causes
    // the corruption the lock exists to prevent.
    expect(fs.existsSync(lockPath(d))).toBe(true);
  });

  it('breaks a stale lock whose holder is gone, and says so on stderr', () => {
    const d = repo();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    plantLock(d, { pid: DEAD_PID, ageMs: 5_000 });

    const result = withAlignDirLock(d, 'align check', () => 'proceeded', { staleAfterMs: 1_000, waitTimeoutMs: 2_000, pollIntervalMs: 5 });

    expect(result).toBe('proceeded');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('breaking a stale .align/ lock'));
    expect(fs.existsSync(lockPath(d))).toBe(false);
  });

  it('does NOT break a dead holder that is younger than the staleness floor', () => {
    const d = repo();
    // Age is the backstop for a recycled pid: a lock created a moment ago whose pid does not resolve
    // is more likely a pid we misjudged than a crash, so the age floor has to be cleared too.
    plantLock(d, { pid: DEAD_PID, ageMs: 0 });

    expect(() => withAlignDirLock(d, 'align check', () => 'never', { staleAfterMs: 60_000, waitTimeoutMs: 100, pollIntervalMs: 5 })).toThrow(
      /timed out/,
    );
  });

  it('never breaks a lock held by another HOST, however old', () => {
    const d = repo();
    // A pid from another machine says nothing locally — `process.kill(pid, 0)` would answer about an
    // unrelated local process of the same number. Refusing costs a confused user one `rm`; guessing
    // costs them the baseline.
    plantLock(d, { pid: DEAD_PID, host: 'some-other-host', ageMs: 10 * 60_000 });

    expect(() => withAlignDirLock(d, 'align check', () => 'never', { staleAfterMs: 1_000, waitTimeoutMs: 100, pollIntervalMs: 5 })).toThrow(
      /timed out/,
    );
    expect(fs.existsSync(lockPath(d))).toBe(true);
  });

  it('treats an unreadable lock file as held by someone unidentifiable, not as absent', () => {
    const d = repo();
    fs.mkdirSync(path.dirname(lockPath(d)), { recursive: true });
    fs.writeFileSync(lockPath(d), 'not json at all');

    // Corrupt is not absent (ADR 028's discipline, applied to the lock itself). The file is right
    // there; concluding "no holder" from an unparseable one would break a live lock.
    expect(() => withAlignDirLock(d, 'align check', () => 'never', { waitTimeoutMs: 100, pollIntervalMs: 5 })).toThrow(
      /an unidentifiable holder/,
    );
  });

  it('a zero-byte lock — what a kill mid-acquire used to leave — is broken once it is stale', () => {
    const d = repo();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(lockPath(d), ''); // the exact artefact the old two-step acquire produced
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Backdate it past the staleness floor; mtime is the only age an unparseable lock has.
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath(d), old, old);

    const result = withAlignDirLock(d, 'align check', () => 'proceeded', { staleAfterMs: 1_000, waitTimeoutMs: 2_000, pollIntervalMs: 5 });

    // Reproduced before the fix: this timed out and failed, FOREVER, at any age — every later align
    // in the repository bricked until a human deleted the file.
    expect(result).toBe('proceeded');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('breaking a stale .align/ lock'));
  });

  it('a zero-byte lock is NOT broken before the staleness floor', () => {
    const d = repo();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(lockPath(d), '');

    // Calibration for the test above: the recovery is age-gated, not a blanket "unparseable means
    // free to take", so a lock being written right now by a live align is still respected.
    expect(() => withAlignDirLock(d, 'align check', () => 'never', { staleAfterMs: 60_000, waitTimeoutMs: 100, pollIntervalMs: 5 })).toThrow(
      /timed out/,
    );
  });

  it('never leaves a partially-written lock file: the acquire publishes a COMPLETE one', () => {
    const d = repo();
    withAlignDirLock(d, 'align baseline prune', () => {
      const raw = fs.readFileSync(lockPath(d), 'utf8');
      // The whole point of the link-based acquire. Under the old two-step version there was a window
      // where this file existed and was empty.
      const holder = JSON.parse(raw) as { pid: number; command: string; host: string; acquiredAt: string };
      expect(holder.pid).toBe(process.pid);
      expect(holder.command).toBe('align baseline prune');
      expect(Number.isFinite(Date.parse(holder.acquiredAt))).toBe(true);
      return 0;
    });
    // And the temp file it was linked from is gone.
    expect(fs.readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a live holder past the staleness floor is still not broken — liveness, not just age', () => {
    const d = repo();
    // The gap the previous suite had: every "not broken" case was decided by the age floor or the
    // host check before liveness was ever consulted, so `return true` in place of `!processAlive()`
    // survived the whole file. This is the case that requires the liveness check specifically.
    plantLock(d, { pid: process.pid, ageMs: 10 * 60_000 });

    expect(() => withAlignDirLock(d, 'align check', () => 'never', { staleAfterMs: 1_000, waitTimeoutMs: 150, pollIntervalMs: 10 })).toThrow(
      /timed out/,
    );
    expect(fs.existsSync(lockPath(d))).toBe(true);
  });

  it('does not remove a DIFFERENT lock that appeared after the staleness decision', () => {
    const d = repo();
    plantLock(d, { pid: DEAD_PID, ageMs: 5_000 });
    const stale = fs.statSync(lockPath(d));

    // Stand in for the loser of a double-break race: by the time it acts, the lock it judged is gone
    // and a live one has taken its place. A blind `rm` would delete the winner's lock and let two
    // bodies run at once — the exact lost update the lock exists to prevent.
    fs.rmSync(lockPath(d));
    fs.writeFileSync(lockPath(d), JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'the winner', acquiredAt: new Date().toISOString() }));
    const successor = fs.statSync(lockPath(d));
    expect(successor.ino === stale.ino && successor.ctimeMs === stale.ctimeMs).toBe(false);

    // The successor is live and recent, so it is refused rather than broken — and crucially it is
    // still THERE afterwards.
    expect(() => withAlignDirLock(d, 'the loser', () => 'never', { staleAfterMs: 1_000, waitTimeoutMs: 100, pollIntervalMs: 5 })).toThrow(
      /timed out/,
    );
    expect(fs.existsSync(lockPath(d))).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath(d), 'utf8')).command).toBe('the winner');
  });

  it('is re-acquirable after a normal release', () => {
    const d = repo();
    expect(withAlignDirLock(d, 'first', () => 1)).toBe(1);
    expect(withAlignDirLock(d, 'second', () => 2)).toBe(2);
    expect(withAlignDirLock(d, 'third', () => 3)).toBe(3);
  });
});
