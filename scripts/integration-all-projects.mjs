#!/usr/bin/env node
/**
 * Runs `integration/run.mjs` once per KNOWN PROJECT, for the targets passed through, and fails if
 * any project fails — LEDGER D049, closing D012 at the level that matters.
 *
 * **The defect this exists for.** `run.mjs` takes ONE `--project` (default `nest`) and filters its
 * scenario pool by it, so a scenario declared against any other project is silently absent from the
 * run. D012 found exactly that: `prune-incomplete-scan-requires-allow-incomplete` declares
 * `project: 'nest-incomplete'` and is the only integration coverage ADR 023 tier 2 has, and the
 * documented gate command never executed it. D012's own words — *"a release-gate scenario the
 * release-gate command does not execute is not calibration"*.
 *
 * D012 was recorded as fixed, and the scenario itself was. The COMMAND was not: `integration:release`
 * stayed `run.mjs --targets 0.1.4,local`, one project, and the mitigation became a sentence in
 * CLAUDE.md telling a human to remember a second line. That is the shape this project promotes to an
 * executable invariant rather than leaving to memory, and it went unnoticed for three days because
 * the scenario passes when you DO remember — the failure mode is silence, not a red run.
 *
 * **Discovered, never enumerated.** The project list comes from `integration/projects/*.mjs`, the
 * same directory `run.mjs`'s own `loadKnownProjectIds` reads. A hardcoded list here would reproduce
 * the defect one level up: adding a third project would leave it uncovered by the release gate with
 * nothing to notice, which is precisely what happened with the second one.
 *
 * Sequential, not parallel: `run.mjs` invocations share `integration/results/.cache`, and two of
 * them packing local tarballs concurrently is the race its own F12 comment describes.
 *
 * Usage (arguments are forwarded verbatim, minus `--project`, which this script owns):
 *   node scripts/integration-all-projects.mjs --targets local
 *   node scripts/integration-all-projects.mjs --targets 0.1.4,local
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectsDir = path.join(repoRoot, 'integration', 'projects');
const runner = path.join(repoRoot, 'integration', 'run.mjs');

const forwarded = process.argv.slice(2);
if (forwarded.includes('--project')) {
  console.error(
    '[integration-all] --project is not accepted here: this script exists BECAUSE choosing one project is how a ' +
      'release-gate scenario goes unrun (LEDGER D012/D049). Call integration/run.mjs directly if you want a single project.',
  );
  process.exit(2);
}

const projectIds = [];
for (const file of fs.readdirSync(projectsDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(path.join(projectsDir, file));
  projectIds.push(mod.default.id);
}

// A discovery step that finds nothing must be loud. Silently running zero projects and exiting 0 is
// the same "reports success wrongly" class the scenarios themselves are written to catch.
if (projectIds.length === 0) {
  console.error(`[integration-all] no projects found in ${projectsDir} — refusing to report a pass over an empty set.`);
  process.exit(2);
}

console.log(`[integration-all] projects: ${projectIds.join(', ')} (discovered from integration/projects/)`);

const failed = [];
for (const projectId of projectIds) {
  console.log(`\n[integration-all] ===== project '${projectId}' =====`);
  const result = spawnSync(process.execPath, [runner, '--project', projectId, ...forwarded], { stdio: 'inherit' });
  // A signal-terminated child reports `status: null`. Treating that as anything but a failure would
  // let a Ctrl-C'd or OOM-killed project pass silently — the D048 lesson, one process up.
  if (result.status !== 0) failed.push(`${projectId}${result.signal === null ? ` (exit ${result.status})` : ` (${result.signal})`}`);
}

if (failed.length > 0) {
  console.error(`\n[integration-all] FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n[integration-all] all ${projectIds.length} project(s) passed: ${projectIds.join(', ')}`);
