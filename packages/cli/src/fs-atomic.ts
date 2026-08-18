import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Crash-atomic file replacement for everything align persists under `.align/`.
 *
 * **The defect this closes.** `fs.writeFileSync` opens with `O_TRUNC`: the old contents are gone
 * before the new ones land. A process killed in that window — Ctrl-C, an OOM kill, a laptop
 * closing, CI cancelling a job — leaves a truncated or empty file. For a regenerable cache that is
 * an annoyance. For `.align/baseline.json` it destroys human consent decisions, and it destroys
 * them in the one way this project treats as severity zero: the next `align check` reads a
 * zero-length file, `readBaseline` throws "not valid JSON", and the recovery a hurried user reaches
 * for is to delete the file and re-accept — which launders every unreviewed violation in the
 * repository into the baseline.
 *
 * **Why rename.** `rename(2)` is atomic within a filesystem: a reader sees either the whole old
 * file or the whole new one, never a partial write, and never a missing file. The temp file is
 * created in the SAME directory for exactly that reason — a rename across filesystems is not atomic
 * and fails with EXDEV, which is why `os.tmpdir()` is the wrong place for it however convenient.
 *
 * **The two fsyncs, and why the second one is not paranoia.** The first flushes the new contents
 * before the rename, so the rename cannot publish a file whose bytes are still in a buffer. The
 * second flushes the DIRECTORY, so the rename itself survives a power loss — without it a crash can
 * leave the directory entry pointing at neither file. The directory fsync is best-effort: it is not
 * supported on every platform (Windows rejects it, some filesystems return EPERM/EINVAL), and there
 * it is a no-op rather than a failure, because refusing to write at all would be a worse outcome
 * than a slightly weaker durability guarantee.
 *
 * **What this does NOT provide: mutual exclusion.** Two processes calling this concurrently both
 * succeed, and the loser's contents are silently gone — atomically. That is a different defect with
 * a different fix (see `align-lock.ts`); do not read "atomic" as "safe to race".
 *
 * **Two behaviours of `fs.writeFileSync` that a bare rename would silently drop**, both found by
 * adversarial review of the first version of this file and both reproduced before being fixed:
 *
 *   - **Mode.** `writeFileSync` writes through to the existing inode and keeps its permissions; a
 *     rename installs a brand-new inode created under the process umask. Measured: a
 *     `baseline.json` at `0600` came back `0644`. align does not get to widen permissions on a
 *     file in someone else's repository as a side effect of an unrelated fix.
 *   - **Symlinks.** `writeFileSync` follows them; a rename replaces the link itself with a regular
 *     file. Measured: writing through a symlinked `baseline.json` left the real file holding the
 *     OLD content and the link replaced — a silent fork, where every later read goes to one file
 *     and the user's other worktree still sees the other. Repos do share a baseline across git
 *     worktrees, so this is a real configuration, not a hypothetical.
 */
export function writeFileAtomic(file: string, contents: string): void {
  // Follow a symlink to its target and replace THAT, so the link survives and keeps pointing at
  // live content. `realpathSync` throws on a dangling link, which is the one case where writing the
  // link path itself is right (it creates the file the link promised).
  let target = file;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file);
  } catch {
    // Does not exist, or a dangling link: `file` is the correct path to create.
  }

  // Mode of the file being replaced, so the new inode inherits it. `undefined` when there is no
  // existing file — a fresh write correctly gets the process default.
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // No existing file; leave the default.
  }

  const dir = path.dirname(target);
  // Same directory (EXDEV), and a name that cannot collide with a concurrent writer's temp file ON
  // THIS HOST: pid alone is not enough, since one process can write the same artifact twice in a
  // run. `wx` rather than `w` because uniqueness across HOSTS is not guaranteed — two containers on
  // one bind mount can both be pid 1 — and there an exclusive create turns silent mutual corruption
  // into a loud EEXIST at no cost.
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${(counter += 1).toString(36)}.tmp`);

  let handle: number | undefined;
  try {
    handle = fs.openSync(tmp, 'wx');
    if (mode !== undefined) fs.fchmodSync(handle, mode);
    fs.writeFileSync(handle, contents, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Already closed or never valid — the rm below is what actually matters.
      }
    }
    // Never leave the temp file behind: `.align/` is a directory users read, and a litter of
    // `.baseline.json.4821.3.tmp` files is indistinguishable from corruption to someone debugging.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort. The original error is the one worth propagating.
    }
    throw err;
  }

  fsyncDirBestEffort(dir);
}

let counter = 0;

/** See the doc comment above: durability of the rename, where the platform supports it. */
function fsyncDirBestEffort(dir: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(dir, 'r');
    fs.fsyncSync(handle);
  } catch {
    // Windows cannot fsync a directory handle, and some filesystems reject it. Not a failure.
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Nothing useful to do; the write itself already succeeded.
      }
    }
  }
}
