import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConcurrentAlignWriteError } from './concurrent-write-error.js';

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
/**
 * The floor for a holder on ANOTHER HOST, where liveness cannot be checked at all and age is the only
 * evidence available (LEDGER D029).
 *
 * Ten times the local floor, and still generous by three orders of magnitude against what the lock
 * actually does: ADR 030 holds it only around the COMMIT — a token compare, a write, a rename — never
 * across the scan. A legitimate cross-host holder measures in milliseconds. Ten minutes is not a
 * guess about how long work takes; it is a bound past which "another machine is mid-commit" has
 * stopped being a possible explanation.
 */
const FOREIGN_HOST_STALE_AFTER_MS = 10 * 60_000;
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
 * A holder on another host cannot be liveness-checked — a pid from another machine means nothing
 * locally, and `processAlive` would answer about an unrelated process of the same number. So age is
 * the only evidence, and the floor for it is ten times the local one.
 *
 * ***Amended 2026-08-19 (LEDGER D029): this used to read "a holder on another host is never broken,
 * whatever its age", and that was the same misapplied principle the branch immediately below refutes,
 * two lines away.*** The reasoning there is exactly right and applies here verbatim: `.align/.lock` is
 * a file align creates, owns and deletes on every run, holding no user data, so never-break is the
 * UNSAFE direction. What made this one worse than the unidentifiable-holder case is the transport —
 * the lock was gitignored nowhere, so a single `git add -A` after a SIGKILL committed a foreign-host
 * holder that then blocked every writing command, on every teammate's machine and every CI run,
 * permanently. Measured: a planted two-year-old lock from `buildbox-01` made `align baseline accept`
 * wait the full 10s timeout and exit 1, every time.
 *
 * The residual risk this accepts, stated: a genuinely shared `.align/` on a network mount where
 * another host's align is mid-commit ten minutes in. That is not a slow machine, it is a hung one, and
 * a hung holder is exactly what the floor exists to clear.
 */
function isBreakable(holder: LockHolder | undefined, now: number, staleAfterMs: number, file: string): boolean {
  if (holder === undefined) {
    // UNIDENTIFIABLE HOLDER. The first version returned false here on the "corrupt is not absent"
    // principle, and that was the wrong principle to borrow. Reproduced: a lock file that is empty
    // or malformed became UNBREAKABLE AT ANY AGE, so every later align in that repository waited the
    // full timeout and failed, forever, until a human deleted the file. The acquire below can no
    // longer produce such a file — it is created complete, by `link` — so anything unparseable here
    // is external damage, and the only recovery align can offer is age.
    //
    // The distinction that makes this safe rather than reckless: `.align/.lock` is a file align
    // creates, owns and deletes on every run. It holds no user data. "Never break it" is the unsafe
    // direction (a permanently bricked repository), unlike `baseline.json`, where it is the safe one.
    return ageOf(file, now) >= staleAfterMs;
  }
  const age = now - Date.parse(holder.acquiredAt);
  if (!Number.isFinite(age)) return false;
  if (holder.host !== os.hostname()) {
    // Age alone, at the higher floor — there is no liveness signal to combine it with. A lock that
    // arrived through git rather than through a mount lands here too, and its `acquiredAt` is
    // whenever the machine that lost it was interrupted, so it clears on the same rule.
    return age >= FOREIGN_HOST_STALE_AFTER_MS;
  }
  if (age < staleAfterMs) return false;
  return !processAlive(holder.pid);
}

/**
 * Removes the lock ONLY if it is still the same file we judged stale.
 *
 * The race this closes, raised by adversarial review: two waiters A and B both read the same stale
 * lock and both decide it is breakable. A removes it and acquires. B — still between its decision
 * and its removal — then deletes **A's live lock**, and both run their bodies at once, which is
 * precisely the lost update the lock exists to prevent. A blind `rm` cannot tell "the lock I judged"
 * from "whatever is at that path now".
 *
 * Comparing inode + ctime before removing shrinks that window to the gap between `stat` and
 * `unlink`. It does not eliminate it — POSIX offers no compare-and-delete — so this is a mitigation,
 * honestly labelled. The residual is far narrower than the decision-to-removal window it replaces,
 * and the acquire itself is still atomic (`link`), so the worst case is two processes both breaking
 * and only one acquiring.
 */
function breakLock(file: string, identity: string | undefined): void {
  if (identity === undefined) return; // vanished already; the next acquire attempt just succeeds
  if (identityOf(file) !== identity) return; // someone else's lock now — never remove it
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Lost the race to another breaker. Harmless: the acquire below is create-if-absent.
  }
}

/** Identity of the file at `file`, as inode + creation time. `undefined` when it does not exist. */
function identityOf(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.ctimeMs}`;
  } catch {
    return undefined;
  }
}

/** Age from the filesystem, for the one case where the lock cannot speak for itself. */
function ageOf(file: string, now: number): number {
  try {
    return now - fs.statSync(file).mtimeMs;
  } catch {
    return 0; // Vanished under us: not breakable, and the next acquire attempt will just succeed.
  }
}

function describe(holder: LockHolder | undefined): string {
  if (holder === undefined) return 'an unidentifiable holder (the lock file could not be read)';
  return `\`${holder.command}\` (pid ${holder.pid} on ${holder.host}, since ${holder.acquiredAt})`;
}

/** Blocking sleep. `Atomics.wait` rather than a spin loop: this runs on the synchronous write path
 * (every `.align/` writer is sync), so there is no event loop to await on, and a busy-wait would
 * burn a core while the other process finishes. */
let tmpCounter = 0;

/** Writes a COMPLETE holder file at `file`. Separate from the acquire so that the acquire itself is
 * a single atomic `link` of an already-finished file — see `withAlignDirLock`. */
function writeHolderFile(file: string, command: string): void {
  const holder: LockHolder = { pid: process.pid, host: os.hostname(), command, acquiredAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(holder, null, 2)}\n`, 'utf8');
}

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
/**
 * Lock paths this PROCESS is currently holding, for re-entrancy.
 *
 * The lock is an exclusive file: a second acquire from the same process would find its own lock
 * present, wait the full timeout, and throw `ConcurrentAlignWriteError` — align deadlocking against
 * itself and reporting it as a concurrent align. That is reachable the moment one locked writer calls
 * another, which is exactly what `writeBaseline` → `stampAlignVersion` became when the version file
 * gained the lock (LEDGER D031).
 *
 * Re-entrancy is sound here rather than a convenience: the lock's purpose is mutual exclusion between
 * PROCESSES, Node is single-threaded, and everything under it is synchronous — so a nested acquire is
 * already inside the exclusivity the outer one bought. The inner call must NOT release, which is why
 * this is a set the outer frame owns rather than a counter.
 */
const heldByThisProcess = new Set<string>();

export function withAlignDirLock<T>(alignDir: string, command: string, fn: () => T, timings: LockTimings = {}): T {
  fs.mkdirSync(alignDir, { recursive: true });
  const file = lockPath(alignDir);
  // Already ours: run inside the exclusivity we already hold, and leave releasing to the frame that
  // acquired it.
  if (heldByThisProcess.has(file)) return fn();
  // Injectable purely so the tests can exercise the timeout and staleness arms in milliseconds
  // instead of minutes. Not a safety switch — every default below is the production value, and no
  // caller in `src/` passes this.
  const waitTimeoutMs = timings.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const staleAfterMs = timings.staleAfterMs ?? STALE_AFTER_MS;
  const pollIntervalMs = timings.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + waitTimeoutMs;
  const tmpFile = path.join(alignDir, `${LOCK_BASENAME}.${process.pid}.${(tmpCounter += 1).toString(36)}.tmp`);

  for (;;) {
    try {
      // ACQUIRE, and it is one atomic step on purpose. The first version was two — `open(file,'wx')`
      // created an EMPTY lock, then the holder JSON was written into it — and a kill in that window
      // left a lock nothing could parse. Reproduced: that made the lock UNBREAKABLE AT ANY AGE, so
      // every later align in the repository waited the full timeout and failed until a human deleted
      // the file. A lock built to survive crashes had a crash window that bricked the repo.
      //
      // `link` is the fix: the temp file is written COMPLETE first, and `link` publishes it under
      // the lock name only if that name does not exist. There is no moment at which a partial lock
      // is visible. `link` fails with EEXIST when the name is taken, which is the contention signal.
      writeHolderFile(tmpFile, command);
      try {
        fs.linkSync(tmpFile, file);
      } finally {
        // The lock file and the temp now share one inode; dropping the temp name leaves the lock.
        try {
          fs.rmSync(tmpFile, { force: true });
        } catch {
          // Leaves litter in `.align/`, nothing worse; never fail an acquired lock over cleanup.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const holder = readHolder(file);
      if (isBreakable(holder, Date.now(), staleAfterMs, file)) {
        // Named on stderr, never silently: a broken lock means another align died mid-write, which
        // is exactly the moment a user wants to know the file may be mid-history.
        // Two different claims, so two different sentences. On this host align has CHECKED that the
        // process is gone; on another host it has only waited, and saying "no longer running" there
        // would assert something it cannot know (LEDGER D029).
        console.error(
          holder !== undefined && holder.host !== os.hostname()
            ? `align: breaking a .align/ lock left by ${describe(holder)} — it is on another machine, so align cannot ` +
                'check whether that process is alive, and the lock is older than any legitimate hold. If this repository ' +
                'shares .align/ over a network mount and that machine is genuinely mid-write, stop this command.'
            : `align: breaking a stale .align/ lock left by ${describe(holder)} — that process is no longer running.`,
        );
        breakLock(file, identityOf(file));
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ConcurrentAlignWriteError(
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
      heldByThisProcess.add(file);
      return fn();
    } finally {
      // Release even if `fn` threw. `force` because a stale-breaker may already have removed it,
      // and failing to release over a missing file would be its own bug.
      heldByThisProcess.delete(file);
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Nothing safe to do here, and throwing would mask the caller's own error.
      }
    }
  }
}
