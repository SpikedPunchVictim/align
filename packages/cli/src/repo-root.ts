/**
 * Repo-root resolution (bug hunt 2026-08-03, Needs-Review #2): every command used to pass
 * `process.cwd()` straight through with no repo-root detection at all, so `align check` (or
 * `init`'s siblings) run from a subdirectory silently scanned/wrote only that subdirectory.
 * Decision: commands are repo-scoped — they resolve the directory where align is set up, rather
 * than trusting cwd blindly. `align init` is the one exception (by definition it runs before
 * either marker below exists), so it keeps using cwd directly and instead prints the directory it
 * targets (see `commands/init.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALIGN_DIR } from './align-dir.js';
import { reportCliError } from './cli-error.js';
import { CONFIG_FILENAME } from './config.js';

/**
 * Walks up from `startDir` to the nearest ancestor containing either `align.config.ts` or a
 * `.align/` directory — the two markers, either of which is sufficient, that make a directory
 * "the repo root" as far as align's commands are concerned. Both matter independently: `align
 * check --untrusted` (ADR 014) never loads `align.config.ts` and reads `.align/ruleset-ir.json`
 * instead, so a checkout that ships only `.align/` (e.g. a CI job given a trimmed, config-free
 * artifact) must still resolve. Returns the nearest ancestor with either marker — a directory
 * with both is not treated specially over one with only one of them. Stops at the filesystem
 * root; returns `undefined` if neither marker is found anywhere above `startDir`.
 */
export function resolveRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILENAME)) || fs.existsSync(path.join(dir, ALIGN_DIR))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root without finding either marker
    dir = parent;
  }
}

/**
 * The message every "no repo root found" surfacing uses, whichever delivery mechanism the caller
 * needs — `reportCliError` (every command) or a doctor advisory (`align doctor` alone; see
 * `resolveRepoRootForDoctor` below). Names the directory searched from and suggests `align init`,
 * shared so the two delivery paths can never say different things.
 */
export function repoNotFoundMessage(cwd: string): string {
  return (
    `no ${CONFIG_FILENAME} or ${ALIGN_DIR}/ directory found in ${cwd} or any parent directory. ` +
    'Run `align init` to set align up here, or run this command from inside an initialized repo.'
  );
}

/** Prints the one-line stderr notice every command shows when the resolved root differs from
 * cwd — a user running from a subdirectory should be able to tell align operated on the repo
 * root, not be silently surprised either way (in either direction: silently rescoping OR silently
 * doing nothing about it). No-op when `root === cwd`. */
function noticeIfRootDiffers(command: string, cwd: string, root: string): void {
  if (root !== cwd) {
    console.error(`${command}: resolved repo root ${root} (cwd: ${cwd})`);
  }
}

export type RepoRootResolution = { readonly root: string } | { readonly exitCode: number };

/**
 * The command-entry-facing wrapper every non-`init`, non-`doctor` command in `program.ts` calls
 * instead of using `process.cwd()` directly.
 *
 * - Found: returns `{ root }`, after printing the resolved-root notice (see
 *   `noticeIfRootDiffers`) when it differs from cwd.
 * - Not found: reports `repoNotFoundMessage` via the shared `reportCliError` helper and returns
 *   `{ exitCode }` — the caller sets `process.exitCode` from it and must not proceed to run the
 *   command.
 *
 * `align doctor` does NOT use this — its contract is "never fails, exit code always 0"
 * (`config.ts`'s `loadConfig` doc comment; every other environmental problem downgrades to an
 * advisory instead of a non-zero exit), so a missing repo root must downgrade the same way rather
 * than going through `reportCliError`. See `resolveRepoRootForDoctor`.
 */
export function requireRepoRoot(command: string, cwd: string): RepoRootResolution {
  const root = resolveRepoRoot(cwd);
  if (root === undefined) {
    const exitCode = reportCliError(command, repoNotFoundMessage(cwd));
    return { exitCode };
  }
  noticeIfRootDiffers(command, cwd, root);
  return { root };
}

/**
 * `align doctor`'s repo-root resolution (Needs-Review #2 follow-up, 2026-08-08: the first version
 * of this fix used `requireRepoRoot` for doctor too, which made a missing repo root exit
 * non-zero via `reportCliError` — a real regression against doctor's own documented "never
 * fails" contract, since a directory with no align setup at all used to exit 0 with a
 * `config-error` advisory before repo-root resolution existed). Doctor still resolves the root
 * and operates on it (printing the same notice) when one is found; when none is found, it
 * returns the same `repoNotFoundMessage` text as a value instead of printing/exiting — the
 * caller (`program.ts`) passes that into `runDoctor`'s `extraAdvisories` so it goes through
 * doctor's normal advisory formatting (human + `--json`) and its normal always-0 exit code.
 */
export function resolveRepoRootForDoctor(command: string, cwd: string): { readonly root: string } | { readonly notFoundMessage: string } {
  const root = resolveRepoRoot(cwd);
  if (root === undefined) return { notFoundMessage: repoNotFoundMessage(cwd) };
  noticeIfRootDiffers(command, cwd, root);
  return { root };
}
