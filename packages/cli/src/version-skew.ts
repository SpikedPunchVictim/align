import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Advisory, CheckRun } from '@spikedpunch/align-core';
import { ALIGN_VERSION } from './telemetry/process-context.js';

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
 * Prepend a global-vs-local version-skew advisory (running binary ≠ this repo's installed
 * align-core) to a `CheckRun`, so a stale global align shadowing the project-local one is a
 * visible one-liner, not a silent behavior change (e.g. a pre-brace global matching a `{a,b}`
 * selector to zero files).
 *
 * Lifted out of `commands/check.ts` (where it started life as a module-private helper) so every
 * `CheckRun`-producing surface can share one copy instead of growing a second: `align check`
 * (both the trusted and `--untrusted` paths) and the MCP server's `align_check`/`align_violations`
 * (both funnel through `mcp/server.ts`'s `freshCheck`). Do not re-inline this at a new call site —
 * that's exactly the "third copy" failure mode `freshCheck`'s own comment already warns about for
 * a different piece of cross-cutting check output (baseline-debt computation); wire the new
 * surface to this function instead.
 */
export function withVersionSkew(run: CheckRun, rootDir: string): CheckRun {
  const skew = detectVersionSkewAdvisory(rootDir);
  return skew === undefined ? run : { ...run, advisories: [skew, ...run.advisories] };
}
