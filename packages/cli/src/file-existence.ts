import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileExistenceProbe, RepoRelativePath } from '@spikedpunch/align-core';

/**
 * The ONE real filesystem-backed `FileExistenceProbe` (ADR 028 mechanism 2). Every destructive
 * consumer gets its probe from here — `align baseline prune`, `align init`, `align upgrade`'s
 * preview, and the store the composition root hands to `align check`'s move-transfer.
 *
 * One module, not an inline closure per construction site: six copies of a safety predicate are six
 * chances for one of them to drift, which is the "hunt the class, not the instance" discipline
 * CLAUDE.md rule 6 states for defects and this repo applies to their fixes too. It is also the seam
 * that keeps `packages/core` filesystem-free — core declares the type and never implements it.
 *
 * WHY A DIRECTORY LISTING AND NOT `fs.existsSync`. `existsSync` is case-INSENSITIVE on macOS and
 * Windows, and that made this probe change behaviour ADR 028 promises it does not. Measured: with
 * only `utils.ts` on disk, `existsSync(root + '/Utils.ts')` is `true` here. So after a case-only
 * rename (`Utils.ts` → `utils.ts`) the orphaned entry looked "still present", the move-transfer was
 * suppressed, `align check` went RED on a pure rename — violating ADR 006's "a rename must not turn
 * CI red" — and `prune` retained the stale entry forever with no escape. ADR 028 says case-only
 * renames are "recorded rather than fixed" and that "a genuine rename whose old file is genuinely
 * gone still transfers exactly as before"; a case-insensitive probe makes both false.
 *
 * Comparing against the parent directory's actual entry names is case-EXACT on every platform, so
 * the probe now gives the same answer on a developer's Mac as in Linux CI. That equivalence is the
 * real prize: a baseline is a shared, committed artifact, and a probe that disagreed across
 * platforms would make `prune` delete different entries depending on who ran it.
 *
 * It answers "does the working tree still have something at this path", not "is it a regular file" —
 * a directory, a symlink, a FIFO all count, because none of them mean "deleted". Symlinks are
 * listed by name whether or not their target resolves, which is what retains a symlinked file the
 * walk itself could not follow (ADR 028 mechanism #7, the reproduced one).
 *
 * NOT CACHED, deliberately. A per-instance directory cache would be a stale view of a filesystem
 * the user is actively editing, and the MCP server is long-lived. The probe runs only for orphaned
 * entries the scan did not observe — a set that is empty on a healthy repo and bounded by baseline
 * size on an unhealthy one — so there is nothing here worth trading correctness for.
 *
 * WHAT IT CANNOT DO, stated because it is load-bearing for the design and not a limitation to fix
 * here: a file inside a `chmod 000` directory reads as ABSENT, because listing that directory
 * throws `EACCES` (exactly as `existsSync` swallowed it before). That is mechanism #5, the other
 * reproduced severity-zero, and this probe misses it. Stage 1's blind-spot record is what covers
 * it — the walk knows the directory was unreadable. Do not "improve" this believing it closes that
 * gap; measured, it does not, and `prune-existence-probe.test.ts` pins the probe failing there so
 * the two mechanisms cannot be collapsed into one by someone who has not read the measurement.
 *
 * NEVER THROWS, per the `FileExistenceProbe` contract — every failure to read becomes `false`,
 * which is the honest answer to "I could not confirm this exists": the entry stays eligible for the
 * ordinary deleted/renamed reasoning rather than being retained forever on an error nobody saw.
 */
export function createFileExistenceProbe(rootDir: string): FileExistenceProbe {
  return (file: RepoRelativePath): boolean => {
    // Baseline entries are repo-relative with forward slashes (`toRepoRelativePath` canonicalizes
    // separators at brand construction); `path.resolve` re-applies the platform separator, so this
    // is correct on Windows without the probe having to know that.
    const absolute = path.resolve(rootDir, file);
    // Containment: a hand-edited or corrupted `.align/baseline.json` can carry `..` — the schema is
    // `z.string().min(1)` and the brand only normalizes separators, so nothing upstream rejects it.
    // Probing outside the repo would let a path align does not own keep an entry un-prunable
    // forever. `''` is excluded for the same reason: it resolves to the root itself, which exists,
    // and would retain the entry permanently.
    const relative = path.relative(rootDir, absolute);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    try {
      return fs.readdirSync(path.dirname(absolute)).includes(path.basename(absolute));
    } catch {
      // Missing parent, unreadable parent (EACCES — mechanism #5), a path component that is not a
      // directory (ENOTDIR), a symlink cycle (ELOOP), an over-long path (ENAMETOOLONG).
      return false;
    }
  };
}
