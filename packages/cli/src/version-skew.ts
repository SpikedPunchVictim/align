import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Advisory } from '@spikedpunch/align-core';
import { ALIGN_VERSION } from './telemetry/process-context.js';

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
 * Returns `undefined` when there is no readable local install (a missing `align-core` surfaces as
 * the `AlignCoreMissingError` config-load error, not a skew) or the versions match — so it never
 * fires in the normal project-local case, nor when align dogfoods itself (the workspace-linked core
 * carries the same version as the CLI).
 */
export function detectVersionSkewAdvisory(rootDir: string): Advisory | undefined {
  const localCorePkgPath = path.join(rootDir, 'node_modules', '@spikedpunch', 'align-core', 'package.json');
  let localVersion: unknown;
  try {
    localVersion = (JSON.parse(fs.readFileSync(localCorePkgPath, 'utf8')) as { version?: unknown }).version;
  } catch {
    return undefined; // no readable local install — not a skew (missing core is a config-load error)
  }
  if (typeof localVersion !== 'string' || localVersion === ALIGN_VERSION) return undefined;
  return {
    kind: 'version-skew',
    message:
      `the running align binary is ${ALIGN_VERSION}, but this repo has @spikedpunch/align-core ${localVersion} ` +
      `installed — selector/rule behavior may differ from what align.config.ts was authored against (an older, ` +
      `globally-installed align on your PATH commonly shadows the project-local one). Run the project-local ` +
      `binary (\`npx align\` or \`node_modules/.bin/align\`), or align the versions ` +
      `(\`npm i -D @spikedpunch/align-core@${ALIGN_VERSION}\`).`,
  };
}
