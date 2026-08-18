import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A short-held exclusive lock over `.align/`, for the moment a command commits a write.
 *
 * **Scope, stated first because it is the whole design.** This lock is NOT held across a scan. It
 * wraps the commit — re-read, compare, write — and nothing else. Holding it from the initial read
 * through the scan would serialize every concurrent `align check` in a repository for the length of
 * a full scan, which is seconds to minutes on a large monorepo, to protect a write that takes
 * microseconds. That trade is wrong for a tool people run in a pre-commit hook.
 *
 * Because the lock is short, it cannot by itself prevent the lost update it is here to stop: a
 * process that read the baseline before another process wrote it will still compute from stale
 * entries. Detecting THAT is `readBaselineSnapshot`'s job — the token it returns is compared under
 * this lock, which is what makes the comparison sound rather than a TOCTOU race of its own. Lock
 * and token are two halves of one mechanism; neither works alone.
 *
 * **Why a lockfile and not `flock`.** Node has no portable advisory-lock binding, and the one thing
 * this must not do is add a native dependency to a tool whose whole posture is "read-only, no
 * install required". `open(…, 'wx')` is atomic create-if-absent on every platform Node supports.
 *
 * **Takes the `.align` directory, not the repo root, and that is not a style choice.** Resolving the
 * directory here would mean importing `align-dir.ts`, which imports this module — a cycle, which
 * `align check` on this very repository rejected (`arch.no-cycles:repo`) the moment it was written.
 * The dependency runs one way: `align-dir` knows where `.align` is and passes it in; this module
 * knows how to lock a directory and nothing about align's layout.
 */

const LOCK_BASENAME = '.lock';
/** Long enough that a slow commit on a loaded machine never trips it, short enough that a user who
 * kills align mid-write is not locked out for a coffee break. The holder's liveness check below is
 * the primary signal; this is the backstop for the case where a pid was recycled. */
const STALE_AFTER_MS = 60_000;
const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;

interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly acquiredAt: string;
}

export function lockPath(alignDir: string): string {
  return path.join(alignDir, LOCK_BASENAME);
}

function readHolder(file: string): LockHolder | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockHolder;
  } catch {
    // Unreadable or malformed: treat as "held by someone unidentifiable" rather than as absent.
    // Absence is the one thing it definitely is not — the file is there. (ADR 028's discipline,
    // applied to a lock: corrupt is not absent.)
    return undefined;
  }
}

/** Whether `pid` is alive *on this host*. `kill(pid, 0)` throws ESRCH when it is not, EPERM when it
 * is alive but owned by another user — which is still alive, and must not be broken. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Breaking a lock is the one operation here that can cause the corruption the lock prevents, so it
 * is deliberately hard to reach: the holder must be identifiable, on THIS host, demonstrably not
 * running, and older than the staleness floor.
 *
 * A holder on another host is never broken, whatever its age. `.align/` on a network filesystem is
 * unusual but not absurd (a shared build machine, a container mount), and a pid from another host
 * means nothing locally — `processAlive` would answer about an unrelated process of the same
 * number. Refusing there costs a confused user one manual `rm`; guessing costs them a baseline.
 */
function isBreakable(holder: LockHolder | undefined, now: number, staleAfterMs: number): boolean {
  if (holder === undefined) return false;
  if (holder.host !== os.hostname()) return false;
  const age = now - Date.parse(holder.acquiredAt);
  if (!Number.isFinite(age) || age < staleAfterMs) return false;
  return !processAlive(holder.pid);
}

function describe(holder: LockHolder | undefined): string {
  if (holder === undefined) return 'an unidentifiable holder (the lock file could not be read)';
  return `\`${holder.command}\` (pid ${holder.pid} on ${holder.host}, since ${holder.acquiredAt})`;
}

/** Blocking sleep. `Atomics.wait` rather than a spin loop: this runs on the synchronous write path
 * (every `.align/` writer is sync), so there is no event loop to await on, and a busy-wait would
 * burn a core while the other process finishes. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockTimings {
  /** How long to wait for a held lock before giving up. */
  readonly waitTimeoutMs?: number;
  /** How old a lock must be before a dead holder makes it breakable. */
  readonly staleAfterMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * Runs `fn` holding the `.align/` lock, and always releases it.
 *
 * `command` is recorded in the lock file and shown to whoever collides with it — "another align
 * process is writing" is unactionable, "`align baseline prune` (pid 4821)" tells a user which
 * terminal to look at.
 *
 * **Acquisition and execution are in separate `try` blocks on purpose.** The first draft wrapped
 * both in one, so any error escaping `fn` was inspected for `EEXIST` — and `fn` here is a
 * filesystem write, which can raise exactly that. A caller's `EEXIST` would have been mistaken for
 * lock contention and retried in a loop until the deadline, then reported as "timed out waiting for
 * the lock" with the real error discarded. Caught while writing the tests below, never shipped.
 */
export function withAlignDirLock<T>(alignDir: string, command: string, fn: () => T, timings: LockTimings = {}): T {
  fs.mkdirSync(alignDir, { recursive: true });
  const file = lockPath(alignDir);
  // Injectable purely so the tests can exercise the timeout and staleness arms in milliseconds
  // instead of minutes. Not a safety switch — every default below is the production value, and no
  // caller in `src/` passes this.
  const waitTimeoutMs = timings.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const staleAfterMs = timings.staleAfterMs ?? STALE_AFTER_MS;
  const pollIntervalMs = timings.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + waitTimeoutMs;

  for (;;) {
    let handle: number;
    try {
      // 'wx' — atomic create-if-absent. This, and only this, is the acquire.
      handle = fs.openSync(file, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const holder = readHolder(file);
      if (isBreakable(holder, Date.now(), staleAfterMs)) {
        // Named on stderr, never silently: a broken lock means another align died mid-write, which
        // is exactly the moment a user wants to know the file may be mid-history.
        console.error(`align: breaking a stale .align/ lock left by ${describe(holder)} — that process is no longer running.`);
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `align: timed out after ${waitTimeoutMs / 1000}s waiting for the .align/ lock, held by ${describe(holder)}. ` +
            'Another align process is writing to this repository. Wait for it to finish and retry. ' +
            `If you are certain no align process is running, delete ${file}.`,
        );
      }
      sleepSync(pollIntervalMs);
      continue;
    }

    // Held. Everything from here runs with the lock and must release it on every path.
    try {
      const holder: LockHolder = { pid: process.pid, host: os.hostname(), command, acquiredAt: new Date().toISOString() };
      try {
        fs.writeFileSync(handle, `${JSON.stringify(holder, null, 2)}\n`, 'utf8');
      } finally {
        fs.closeSync(handle);
      }
      return fn();
    } finally {
      // Release even if `fn` threw. `force` because a stale-breaker may already have removed it,
      // and failing to release over a missing file would be its own bug.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Nothing safe to do here, and throwing would mask the caller's own error.
      }
    }
  }
}
