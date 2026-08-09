import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Advisory, CheckRun } from '@spikedpunch/align-core';
import { ALIGN_VERSION } from './telemetry/process-context.js';
import { readVersionFile } from './align-dir.js';

/**
 * Resolves `@spikedpunch/align-core`'s `package.json` the way Node itself resolves `node_modules`:
 * walk up from `rootDir` to the filesystem root, checking `<dir>/node_modules/@spikedpunch/align-core`
 * at each level, and stop at the first one found (ADR 021 gap 1). A flat `path.join(rootDir, ...)`
 * lookup only ever checks `rootDir` itself, which misses a hoisted monorepo — npm/yarn workspaces,
 * or pnpm with the dep declared at the workspace root — where `align-core` lives above the package
 * being checked. Checking the closest directory first (before its parent) mirrors Node's own
 * resolution order, so a package-local override still wins over a workspace-root hoist, exactly as
 * `require`/`import` would resolve it.
 */
function resolveLocalCorePackageJsonPath(rootDir: string): string | undefined {
  let dir = path.resolve(rootDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@spikedpunch', 'align-core', 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root — nothing found anywhere up the tree
    dir = parent;
  }
}

/**
 * Detects a global-vs-local align version skew and returns an advisory when found. The running CLI
 * (`ALIGN_VERSION`) and the `@spikedpunch/align-core` installed in the target repo ship in lockstep
 * — create-align pins them together, the monorepo bumps them together — so a version *difference*
 * means the binary that's running is NOT this repo's pinned install. That is almost always a stale
 * GLOBAL align (e.g. `/opt/homebrew/bin/align`, a `npm i -g` install) shadowing the project-local
 * one on `PATH`. Its matcher/rule behavior can silently diverge from what `align.config.ts` was
 * authored against — e.g. a pre-0.1.3 global doesn't expand `{a,b}` selector braces, so a
 * populated component matches zero files and (until the fail-scoped gate lands) the whole
 * architecture phase goes dark, with only a confusing "stale selector" as the visible symptom.
 *
 * The `align-core` install is resolved by walking parent directories from `rootDir`, mirroring how
 * Node itself resolves `node_modules` (`resolveLocalCorePackageJsonPath`, ADR 021 gap 1) — the repo
 * being checked doesn't have to be the one with `align-core` physically inside its own
 * `node_modules` for the skew check to see it, which is the normal shape of a hoisted monorepo.
 * The resolved path is included in the advisory message so a user can see exactly which install was
 * compared against.
 *
 * Returns `undefined` when there is no readable local install anywhere up the tree (a missing
 * `align-core` surfaces as the `AlignCoreMissingError` config-load error, not a skew) or the
 * versions match — so it never fires in the normal project-local case, nor when align dogfoods
 * itself (the workspace-linked core carries the same version as the CLI).
 */
export function detectVersionSkewAdvisory(rootDir: string): Advisory | undefined {
  const localCorePkgPath = resolveLocalCorePackageJsonPath(rootDir);
  if (localCorePkgPath === undefined) return undefined; // no readable local install anywhere up the tree — not a skew

  let localVersion: unknown;
  try {
    localVersion = (JSON.parse(fs.readFileSync(localCorePkgPath, 'utf8')) as { version?: unknown }).version;
  } catch {
    return undefined; // found the path but couldn't read/parse it — not a skew (missing core is a config-load error)
  }
  if (typeof localVersion !== 'string' || localVersion === ALIGN_VERSION) return undefined;
  return {
    kind: 'version-skew',
    message:
      `the running align binary is ${ALIGN_VERSION}, but this repo has @spikedpunch/align-core ${localVersion} ` +
      `installed at ${localCorePkgPath} — selector/rule behavior may differ from what align.config.ts was authored ` +
      `against (an older, globally-installed align on your PATH commonly shadows the project-local one). Run the ` +
      `project-local binary (\`npx align\` or \`node_modules/.bin/align\`), or align the versions ` +
      `(\`npm i -D @spikedpunch/align-core@${ALIGN_VERSION}\`).`,
  };
}

/**
 * Splits a plain `major.minor.patch`-shaped version string into numeric parts. Deliberately not a
 * full semver parser (no prerelease/build-metadata handling) — align's own releases are plain
 * `x.y.z` (see every version literal in this file's tests and `package.json`), and a heavier
 * dependency to parse a three-integer tuple would be generic-theatre (CODING_BEST_PRACTICES.md
 * §13). Returns `undefined` for anything that doesn't parse as three non-negative integers, so the
 * caller can fall back to a direct string comparison rather than crash on an unexpected format.
 */
function parseSimpleVersion(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  return [Number(major), Number(minor), Number(patch)];
}

/**
 * Compares two version strings, returning positive when `a` is newer than `b`, negative when `a`
 * is older, and `0` when equal (or when neither parses, in which case string equality is the only
 * fact left to report). Numeric `major.minor.patch` comparison when both parse; a plain string
 * comparison as the fallback keeps this total (never throws) for a non-semver stamp — e.g. a hand
 * edited or pre-release build string — which must still resolve to SOME ordering rather than crash
 * the advisory it feeds.
 */
function compareVersions(a: string, b: string): number {
  const pa = parseSimpleVersion(a);
  const pb = parseSimpleVersion(b);
  if (pa === undefined || pb === undefined) return a === b ? 0 : a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Detects skew between the running align binary and `.align/version.json`'s `alignVersion` stamp
 * (ADR 021 gap 2, ADR 022's "align check reads it" section) — a DIFFERENT signal from
 * `detectVersionSkewAdvisory` above, which compares the running binary against this repo's
 * INSTALLED `@spikedpunch/align-core` (a package.json on disk). This one compares the running
 * binary against a RECORD of which align last wrote `.align/` — the two can disagree independently
 * (e.g. a correctly-matched local install, but a baseline nobody has touched since an old release).
 *
 * Three outcomes, each deliberately distinct:
 *  - **Absent stamp** → `undefined` HERE, and reported by `align doctor` instead
 *    (`buildUnknownProvenanceAdvisory`, `commands/doctor.ts`). ADR 022 originally put this on
 *    `align check`; that was wrong and the ADR was amended. An absent stamp is the normal,
 *    permanent steady state for every pre-0.2.0 install and for every repo whose users only run
 *    `check` — which is the CI case, i.e. most repos — because a check must not mutate the repo it
 *    is checking and therefore never creates the file. Advising on it from `check` meant a
 *    non-actionable warning on every run that the user could only silence by mutating their repo,
 *    which is how an advisory channel gets tuned out and takes the skew advisory below down with
 *    it. `doctor` is the read-only survey command — the place someone asks "tell me about my
 *    setup" — so the observation lives there.
 *  - **Stamp matches the running binary** → `undefined`, no advisory (the common, lockstep case).
 *  - **Stamp differs** → an `artifact-version-skew` advisory, with the direction called out
 *    explicitly rather than a generic "differs": a stamp OLDER than the running binary (the
 *    upgrade direction — the common case, a repo whose align was just upgraded) means some
 *    baseline entries may reflect a fingerprinting scheme that has since changed. A stamp NEWER
 *    than the running binary (the downgrade direction) is the more dangerous case and is named as
 *    such: artifacts written by a newer align may encode fingerprints THIS binary cannot even
 *    reproduce, not just interpret differently.
 *
 * Reuses `readVersionFile` (`align-dir.ts`) rather than re-reading/re-parsing the file — the same
 * corrupt-≠-absent discipline applies here as everywhere else this file is read, so a corrupted
 * `.align/version.json` throws (caught by `align check`'s own top-level error handling) instead of
 * silently reporting "no skew".
 */
export function detectArtifactVersionSkewAdvisory(rootDir: string): Advisory | undefined {
  const stamp = readVersionFile(rootDir);
  // Absent → not a check-time signal. See this function's doc comment and
  // `buildUnknownProvenanceAdvisory` below.
  if (stamp === undefined) return undefined;
  if (stamp.alignVersion === ALIGN_VERSION) return undefined;

  const cmp = compareVersions(stamp.alignVersion, ALIGN_VERSION);
  if (cmp > 0) {
    // downgrade direction — the stamp is NEWER than the running binary.
    return {
      kind: 'artifact-version-skew',
      message:
        `the running align binary is ${ALIGN_VERSION}, but .align/ was last written by a NEWER align ` +
        `(${stamp.alignVersion}) — DOWNGRADE: artifacts under .align/ may encode fingerprints or shapes this ` +
        `older binary cannot reproduce, not just interpret differently. Upgrade align to ${stamp.alignVersion} ` +
        `or later before trusting this check, or re-run a stamping command (e.g. 'align init') with the current ` +
        `binary to re-establish provenance.`,
    };
  }
  // upgrade direction — the stamp is OLDER than the running binary.
  return {
    kind: 'artifact-version-skew',
    message:
      `the running align binary is ${ALIGN_VERSION}, but .align/ was last written by an OLDER align ` +
      `(${stamp.alignVersion}) — UPGRADE: some baseline entries may reflect a fingerprinting scheme that has ` +
      `since changed, so new-looking debt may be reappearing debt rather than a real regression. Review new ` +
      `debt before accepting it as real; reconcile manually (prune stale entries, re-run check, re-accept real ` +
      `churn) if in doubt.`,
  };
}

/**
 * The absent-stamp half of artifact provenance, split out of
 * `detectArtifactVersionSkewAdvisory` so it reaches `align doctor` ONLY — never `align check`.
 *
 * Why the split (ADR 022, amended 2026-08-09): an absent stamp is not a defect and carries no
 * action. It is the permanent steady state for every install created before 0.2.0, and for every
 * repo whose users only run `align check` — the CI case — because a check never writes the file.
 * On `check` this produced a warning on every run whose only remedy was "mutate your repo to
 * silence me", which trains users to skim past advisories and costs us the one signal in this
 * area that IS actionable: `artifact-version-skew`.
 *
 * `doctor` is align's read-only advisory survey and already carries every other observation of
 * this shape (dead tsconfig aliases, empty components, unmapped files, a stale skill snapshot).
 * Someone running `doctor` is asking to be told about their setup; someone running `check` is
 * asking whether their architecture holds.
 *
 * Returns `undefined` when a stamp exists — including when it disagrees with the running binary,
 * because that case is `detectArtifactVersionSkewAdvisory`'s and must not be double-reported.
 */
export function buildUnknownProvenanceAdvisory(rootDir: string): Advisory | undefined {
  if (readVersionFile(rootDir) !== undefined) return undefined;
  return {
    kind: 'artifact-version-unknown',
    message:
      `.align/ carries no version.json stamp, so which align version last wrote these artifacts is unknown — ` +
      `either this install predates 0.2.0, or nothing in .align/ has been written since (a plain 'align check' ` +
      `never creates the file, by design). Nothing is wrong and nothing needs doing: provenance is simply ` +
      `unrecorded, and the next command that writes .align/ will record it.`,
  };
}

/**
 * Prepend BOTH version-skew advisories to a `CheckRun` — the global-vs-local skew
 * (`detectVersionSkewAdvisory`, running binary vs. this repo's installed `align-core`) and the
 * artifact-provenance skew (`detectArtifactVersionSkewAdvisory`, running binary vs.
 * `.align/version.json`'s stamp, ADR 021/022). Two different questions, one shared choke point, so
 * every `CheckRun`-producing surface picks up both with no per-site wiring.
 *
 * Lifted out of `commands/check.ts` (where the first of the two started life as a module-private
 * helper) so every `CheckRun`-producing surface can share one copy instead of growing a second:
 * `align check` (both the trusted and `--untrusted` paths) and the MCP server's
 * `align_check`/`align_violations` (both funnel through `mcp/server.ts`'s `freshCheck`). Do not
 * re-inline either detector at a new call site — that's exactly the "third copy" failure mode
 * `freshCheck`'s own comment already warns about for a different piece of cross-cutting check
 * output (baseline-debt computation); wire the new surface to this function instead. This is also
 * why the artifact-provenance advisory was added HERE rather than as a second call at each of
 * `check.ts`'s two functions and `mcp/server.ts`'s `freshCheck` — one new advisory, zero new call
 * sites.
 *
 * `detectArtifactVersionSkewAdvisory` can throw (a corrupted `.align/version.json`, the same
 * corrupt-≠-absent discipline every other artifact reader in this codebase follows) — callers that
 * don't already have a blanket try/catch around their `CheckRun` pipeline must add one, the same
 * way `readBaseline`'s throw is already handled at each of this function's call sites.
 */
export function withVersionSkew(run: CheckRun, rootDir: string): CheckRun {
  const advisories: Advisory[] = [];
  const skew = detectVersionSkewAdvisory(rootDir);
  if (skew !== undefined) advisories.push(skew);
  const artifactSkew = detectArtifactVersionSkewAdvisory(rootDir);
  if (artifactSkew !== undefined) advisories.push(artifactSkew);
  return advisories.length === 0 ? run : { ...run, advisories: [...advisories, ...run.advisories] };
}
