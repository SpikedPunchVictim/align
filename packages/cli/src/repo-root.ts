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
 * Directory names the nested-subproject scan below never descends into. Deliberately a small local
 * copy rather than an import of `plugin-typescript`'s `DEFAULT_EXCLUDED_DIR_NAMES`: that constant
 * is module-private to `scanner.ts` (plugin-typescript already keeps its own second copy in
 * `doctor.ts` for the same reason), so reusing it would mean newly exporting a scanner internal
 * through the plugin's public surface just to serve a CLI error message — widening a package's
 * public API for an unrelated concern, and coupling this message's traversal policy to the TS
 * scanner's source-file traversal policy, which are free to diverge. `cli -> plugin-typescript` is
 * permitted by align's own ruleset, so this is an API-surface/coupling call, not a conformance one.
 *
 * Dot-directories are skipped wholesale by `isUninterestingDirName` EXCEPT `.align` itself, which
 * is one of the two markers being looked for.
 */
const NESTED_SCAN_SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.build',
  '.history',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'out',
  'target',
  'vendor',
  'venv',
  '__pycache__',
]);

/** How far below the start directory the nested-subproject scan looks. 2 covers the shapes this
 * exists for (`typescript/`, `services/api/`) without turning a run from `$HOME` into a tree walk. */
const NESTED_SCAN_MAX_DEPTH = 2;
/** Hard ceiling on directories read. A user who runs a command from `/` or `$HOME` must get an
 * answer immediately; hitting this cap with nothing found falls back to the generic message. */
const NESTED_SCAN_MAX_DIRS = 400;
/** How many nested setups the message names before switching to "and N more". */
const NESTED_SCAN_MAX_NAMED = 3;

function isUninterestingDirName(name: string): boolean {
  if (name === ALIGN_DIR) return false; // one of the two markers — never skipped
  return name.startsWith('.') || NESTED_SCAN_SKIPPED_DIR_NAMES.has(name);
}

/**
 * Breadth-first, bounded, read-only scan DOWNWARD from `startDir` for directories that do have an
 * align setup. Exists because the upward walk's "run `align init` here" advice is actively wrong in
 * a common real shape: a polyglot monorepo whose git root holds several subprojects with align set
 * up in exactly one of them (verified on a real repo with `typescript/`, `python/`, `website/`
 * siblings) — following that advice creates a second, competing align setup at the wrong level.
 *
 * Bounded three ways: depth (`NESTED_SCAN_MAX_DEPTH`), total directories read
 * (`NESTED_SCAN_MAX_DIRS`), and the skip list above. Breadth-first so the shallowest — i.e. most
 * likely intended — subprojects are the ones that survive a budget cutoff. Symlinked directories
 * are not followed (`Dirent.isDirectory()` is false for a symlink), which also makes cycles
 * impossible. Unreadable directories are skipped silently: this only ever decorates an error
 * message, so it must never itself throw.
 */
function scanForNestedRepoRoots(startDir: string): readonly string[] {
  const found: string[] = [];
  const queue: { readonly dir: string; readonly depth: number }[] = [{ dir: startDir, depth: 0 }];
  let dirsRead = 0;
  while (queue.length > 0) {
    if (dirsRead >= NESTED_SCAN_MAX_DIRS) break;
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
      dirsRead += 1;
    } catch {
      continue; // unreadable (permissions, races) — never let a decoration break the message
    }
    const hasMarker = entries.some(
      (e) => (e.isFile() && e.name === CONFIG_FILENAME) || (e.isDirectory() && e.name === ALIGN_DIR),
    );
    // depth 0 is `startDir`, which the caller already established has no marker.
    if (depth > 0 && hasMarker) {
      found.push(dir);
      continue; // an initialized subproject is a leaf for this purpose — don't scan inside it
    }
    if (depth >= NESTED_SCAN_MAX_DEPTH) continue;
    const childNames = entries
      .filter((e) => e.isDirectory() && !isUninterestingDirName(e.name))
      .map((e) => e.name)
      .sort(); // readdir order is not guaranteed — sort so the message is byte-identical run to run
    for (const name of childNames) queue.push({ dir: path.join(dir, name), depth: depth + 1 });
  }
  return found;
}

/** `typescript/`, `packages/app/` — start-relative, always POSIX-separated and trailing-slashed so
 * the message reads as a directory the user can `cd` into. */
function toDisplayPath(startDir: string, dir: string): string {
  return `${path.relative(startDir, dir).split(path.sep).join('/')}/`;
}

/**
 * The message every "no repo root found" surfacing uses, whichever delivery mechanism the caller
 * needs — `reportCliError` (every command) or a doctor advisory (`align doctor` alone; see
 * `resolveRepoRootForDoctor` below). Names the directory searched from, shared so the two delivery
 * paths can never say different things.
 *
 * Two endings. When a bounded downward scan finds align set up in a subdirectory, the message
 * points at it instead of suggesting `align init` — suggesting `init` at the git root of a
 * polyglot monorepo whose `typescript/` subproject already has align is bad advice that creates a
 * second, competing setup. When nothing is found below either, the original `align init` wording
 * is kept verbatim: that case is still correct.
 */
export function repoNotFoundMessage(cwd: string): string {
  const prefix = `no ${CONFIG_FILENAME} or ${ALIGN_DIR}/ directory found in ${cwd} or any parent directory. `;
  const nested = scanForNestedRepoRoots(cwd);
  if (nested.length === 0) {
    return `${prefix}Run \`align init\` to set align up here, or run this command from inside an initialized repo.`;
  }
  const named = nested.slice(0, NESTED_SCAN_MAX_NAMED).map((dir) => toDisplayPath(cwd, dir));
  const remaining = nested.length - named.length;
  const list = named.join(', ') + (remaining > 0 ? `, and ${remaining} more` : '');
  const subject = nested.length === 1 ? 'a subdirectory' : 'subdirectories';
  return `${prefix}align is already set up in ${subject} of this directory (${list}) — run this command from there.`;
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
