#!/usr/bin/env node
// Cross-version integration harness — entry point (ADR 025). Works identically from a plain
// `node integration/run.mjs ...` on a dev machine and from inside the Docker image
// (`integration/Dockerfile`) — no environment-specific branches anywhere in this file.
//
// Usage:
//   node integration/run.mjs [--project nest] [--targets local] [--scenarios id1,id2]
//                             [--gate-target local] [--out <dir>] [--keep-all]
//
// Examples:
//   node integration/run.mjs                              # all scenarios, against 'local' only
//   node integration/run.mjs --targets 0.1.4,local         # the red/green proof, side by side
//   node integration/run.mjs --scenarios prune-errored-run-destroys-baseline --targets 0.1.4,local
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareProjectBase, materializeWorkingCopy } from './lib/project.mjs';
import { runScenario } from './lib/scenario-runner.mjs';
import { ensureDir, removeDir, writeJson } from './lib/fs-utils.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const alignRepoRoot = path.join(here, '..');

function parseArgs(argv) {
  const args = { project: 'nest', targets: ['local'], scenarios: undefined, gateTarget: undefined, out: undefined, keepAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--targets') args.targets = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--scenarios') args.scenarios = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--gate-target') args.gateTarget = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--keep-all') args.keepAll = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node integration/run.mjs [--project nest] [--targets local] [--scenarios id1,id2] [--gate-target local] [--out dir] [--keep-all]',
      );
      process.exit(0);
    } else throw new Error(`unrecognized argument '${a}'`);
  }
  return args;
}

async function loadProject(id) {
  const mod = await import(path.join(here, 'projects', `${id}.mjs`));
  return mod.default;
}

async function loadScenarios(filterIds, projectId) {
  const dir = path.join(here, 'scenarios');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const all = [];
  for (const f of files) {
    const mod = await import(path.join(dir, f));
    all.push(mod.default);
  }
  // A scenario declares the project it was authored against (mutations like
  // 'introduce-arch-violation' read project-specific component names) — running it against a
  // mismatched --project would silently mutate the wrong component names. Filtered here, not left
  // as an implicit assumption.
  const forProject = all.filter((s) => s.project === projectId);
  const pool = filterIds === undefined ? forProject : all.filter((s) => filterIds.includes(s.id));
  for (const s of pool) {
    if (s.project !== projectId) throw new Error(`scenario '${s.id}' is authored for project '${s.project}', not '${projectId}'`);
  }
  if (filterIds === undefined) return pool;
  const byId = new Map(pool.map((s) => [s.id, s]));
  return filterIds.map((id) => {
    const s = byId.get(id);
    if (s === undefined) throw new Error(`unknown scenario '${id}' for project '${projectId}' — known: ${[...byId.keys()].join(', ')}`);
    return s;
  });
}

/** The subset of a captured step used for the determinism check — deliberately excludes
 * `durationMs`, raw (pre-normalization) text, and `capturedAt`, so two runs of the same scenario
 * against the same version can be compared byte-for-byte via a plain diff of this file alone. */
function toNormalizedStep(step) {
  const alignFiles = {};
  for (const [name, entry] of Object.entries(step.stateAfter.alignFiles)) {
    alignFiles[name] = entry.present ? { present: true, normalized: entry.normalized } : { present: false };
  }
  return {
    index: step.index,
    kind: step.kind,
    pass: step.pass,
    failures: step.failures,
    ...(step.command !== undefined ? { command: step.command, expect: step.expect } : {}),
    ...(step.name !== undefined ? { name: step.name } : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.spec !== undefined ? { spec: step.spec } : {}),
    ...(step.result !== undefined
      ? { exitCode: step.result.exitCode, stdoutNormalized: step.result.stdoutNormalized, stderrNormalized: step.result.stderrNormalized }
      : {}),
    stateAfter: {
      alignFiles,
      alignConfig: step.stateAfter.alignConfig.present ? { present: true, normalized: step.stateAfter.alignConfig.normalized } : { present: false },
      claudeMdBlock: step.stateAfter.claudeMdBlock.present
        ? { present: true, normalized: step.stateAfter.claudeMdBlock.normalized }
        : { present: false },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gateTarget = args.gateTarget ?? (args.targets.includes('local') ? 'local' : args.targets[0]);
  const cacheRoot = path.join(alignRepoRoot, 'integration', 'results', '.cache');
  const tarballCacheDir = path.join(cacheRoot, 'tarballs');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out ?? path.join(alignRepoRoot, 'integration', 'results', runId);
  ensureDir(outDir);

  const log = (msg) => console.log(msg);
  log(`[run] runId=${runId} project=${args.project} targets=${args.targets.join(',')} gateTarget=${gateTarget}`);
  log(`[run] output: ${outDir}`);

  const project = await loadProject(args.project);
  const scenarios = await loadScenarios(args.scenarios, args.project);
  log(`[run] scenarios: ${scenarios.map((s) => s.id).join(', ')}`);

  const basePath = prepareProjectBase(project, cacheRoot, log);

  /** @type {{target: string, scenarioId: string, pass: boolean, errored: boolean}[]} */
  const matrix = [];

  for (const target of args.targets) {
    for (const scenario of scenarios) {
      const workDir = path.join(cacheRoot, 'work', `${runId}--${target}--${scenario.id}`);
      log(`\n=== ${scenario.id} @ ${target} ===`);
      materializeWorkingCopy(basePath, workDir);

      const result = await runScenario(scenario, { project, target, workingDir: workDir, alignRepoRoot, tarballCacheDir, log });

      const scenarioOutDir = path.join(outDir, target, scenario.id);
      ensureDir(scenarioOutDir);
      writeJson(path.join(scenarioOutDir, 'steps.json'), result.steps);
      writeJson(path.join(scenarioOutDir, 'normalized.json'), result.steps.map(toNormalizedStep));
      writeJson(path.join(scenarioOutDir, 'result.json'), {
        scenarioId: result.scenarioId,
        target: result.target,
        pass: result.pass,
        errored: result.errored,
        errorMessage: result.errorMessage,
        stepFailures: result.steps.filter((s) => s.pass === false).map((s) => ({ index: s.index, kind: s.kind, failures: s.failures })),
      });

      const status = result.errored ? 'ERROR' : result.pass ? 'PASS' : 'FAIL';
      log(`--- ${scenario.id} @ ${target}: ${status} ---`);
      if (status !== 'PASS') {
        if (result.errored) log(`    harness error: ${result.errorMessage}`);
        for (const s of result.steps.filter((s2) => s2.pass === false)) {
          log(`    step ${s.index} (${s.kind}) failed: ${s.failures.join('; ')}`);
        }
      }

      matrix.push({ target, scenarioId: scenario.id, pass: result.pass, errored: result.errored });

      // Keep the working copy for post-hoc diagnosis on failure (ADR 025 §2) — remove it on
      // success to bound disk usage across a multi-target, multi-scenario run.
      if (result.pass && !args.keepAll) removeDir(workDir);
      else log(`    working copy preserved: ${workDir}`);
    }
  }

  log('\n=== summary ===');
  const width = Math.max(...matrix.map((m) => m.scenarioId.length));
  for (const target of args.targets) {
    log(`  target ${target}:`);
    for (const m of matrix.filter((m2) => m2.target === target)) {
      const status = m.errored ? 'ERROR' : m.pass ? 'PASS' : 'FAIL';
      log(`    ${m.scenarioId.padEnd(width)}  ${status}`);
    }
  }

  writeJson(path.join(outDir, 'summary.json'), { runId, project: args.project, targets: args.targets, gateTarget, matrix });

  const gateFailures = matrix.filter((m) => m.target === gateTarget && !m.pass);
  if (gateFailures.length > 0) {
    log(`\n[run] GATE FAILED for target '${gateTarget}': ${gateFailures.map((m) => m.scenarioId).join(', ')}`);
    process.exitCode = 1;
  } else {
    log(`\n[run] gate target '${gateTarget}': all scenarios passed.`);
  }

  const nonGateFailures = matrix.filter((m) => m.target !== gateTarget && !m.pass);
  if (nonGateFailures.length > 0) {
    log(
      `[run] non-gate target failure(s) (informational — e.g. the red/green proof against a known-buggy published version): ` +
        nonGateFailures.map((m) => `${m.scenarioId}@${m.target}`).join(', '),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
