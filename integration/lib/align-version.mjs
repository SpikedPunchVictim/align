/**
 * The one place the harness learns what version the working tree is — read from
 * `packages/cli/package.json`, never hand-copied.
 *
 * **Why this module exists.** `KNOWN_ALIGN_VERSIONS` (lib/normalize.mjs) used to be a hand-written
 * literal list ending at the current release, and a version bump that forgot to extend it failed
 * SILENTLY: `local` reports the working tree's version, so the moment `packages/cli/package.json`
 * moved, `local`'s own version string stopped matching the list and was left raw in normalized
 * output. Nothing went red. Scenarios that print a version just quietly stopped being comparable
 * across runs, which is the harness losing a property while still reporting PASS.
 *
 * That made it the one release step whose omission no test could detect, so `RELEASING.md` had to
 * carry it as a thing a human remembers. Deriving it removes the step instead of documenting it —
 * the same reason `scripts/integration-all-projects.mjs` DISCOVERS its project list rather than
 * enumerating it, and the same reason `cli-inventory.ts` walks the live command tree.
 *
 * `packages/cli/package.json` is the single source of truth for align's version everywhere else
 * too: `ALIGN_VERSION` (packages/cli/src/telemetry/process-context.ts) reads that same file at
 * module load, and `migration-registry-completeness.test.ts` reads it directly rather than
 * consulting the in-process constant. This module is the harness's copy of that discipline.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The working tree's align version — what a `local` install reports.
 *
 * Throws rather than defaulting. A default (`'0.0.0'`, `undefined`) would put this module back in
 * the business of being quietly wrong, which is the exact failure it exists to remove.
 */
export function readWorkingTreeAlignVersion() {
  const pkgPath = path.join(repoRoot, 'packages', 'cli', 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${pkgPath} to determine the working tree's align version: ${err instanceof Error ? err.message : String(err)}`);
  }
  const version = JSON.parse(raw).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${pkgPath} has no usable "version" field — the harness cannot tell what 'local' will report.`);
  }
  return version;
}

/**
 * Versions of align PUBLISHED to npm, oldest first — the ones a scenario can name as a `--targets`
 * entry and actually install.
 *
 * Append when a release ships. Forgetting to is not the silent failure the derived current version
 * above was: a target that is not in this list is one a run had to name explicitly on the command
 * line, and the only consequence is that its version string is not scrubbed from captured output.
 * The steady-state gate (`--targets 0.1.4,local`) reads both entries it needs from here and from
 * the working tree.
 */
export const PUBLISHED_ALIGN_VERSIONS = Object.freeze(['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.2.0']);

/**
 * Every align version string the normalizer should scrub: the published ones plus whatever the
 * working tree currently is. De-duplicated, because the moment a version is published and this
 * tree has not yet bumped past it, it is legitimately both.
 */
export function knownAlignVersions() {
  return [...new Set([...PUBLISHED_ALIGN_VERSIONS, readWorkingTreeAlignVersion()])];
}
