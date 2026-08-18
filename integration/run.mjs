#!/usr/bin/env node
// Cross-version integration harness — entry point (ADR 025). Works identically from a plain
// `node integration/run.mjs ...` on a dev machine and from inside the Docker image
// (`integration/Dockerfile`) — no environment-specific branches anywhere in this file.
//
// Usage:
//   node integration/run.mjs [--project nest] [--targets local] [--scenarios id1,id2]
//                             [--tags tag1,tag2] [--gate-target local] [--out <dir>] [--keep-all]
//
// Examples:
//   node integration/run.mjs                              # all scenarios, against 'local' only
//   node integration/run.mjs --targets 0.1.4,local         # the red/green proof, side by side
//   node integration/run.mjs --scenarios prune-errored-run-destroys-baseline --targets 0.1.4,local
//   node integration/run.mjs --tags destructive --targets local   # ADR 026 item 3: select by tag
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareProjectBase, materializeWorkingCopy } from './lib/project.mjs';
import { runScenario } from './lib/scenario-runner.mjs';
import { ensureDir, removeDir, writeJson } from './lib/fs-utils.mjs';
import { validateScenario, validateNoDuplicateKeys } from './lib/spec-validate.mjs';
// Injected into `validateNoDuplicateKeys` rather than imported inside it, so `spec-validate.mjs`
// stays a pure, dependency-free module the way the rest of `lib/` is — and so a unit-style check of
// the validator can drive it without the harness. Resolves from the repo root's devDependencies
// (the Dockerfile's `pnpm install --frozen-lockfile` provides it, as does CI's).
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const alignRepoRoot = path.join(here, '..');

function parseArgs(argv) {
  const args = { project: 'nest', targets: ['local'], scenarios: undefined, tags: undefined, gateTarget: undefined, out: undefined, keepAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--targets') args.targets = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--scenarios') args.scenarios = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--tags') args.tags = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--gate-target') args.gateTarget = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--keep-all') args.keepAll = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node integration/run.mjs [--project nest] [--targets local] [--scenarios id1,id2] ' +
          '[--tags tag1,tag2] [--gate-target local] [--out dir] [--keep-all]',
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

/** All known project ids (`projects/*.mjs`'s `.id`), used to validate every scenario's `project`
 * field references a REAL project (F4's "unmatched scenario" check) — independent of which
 * `--project` this particular invocation is running, so a typo'd `project: 'nestt'` is caught even
 * if nobody ever runs `--project nestt` (which would trivially fail for an unrelated reason). */
async function loadKnownProjectIds() {
  const dir = path.join(here, 'projects');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const ids = [];
  for (const f of files) {
    const mod = await import(path.join(dir, f));
    ids.push(mod.default.id);
  }
  return ids;
}

/** ADR 026 item 3 (tiering): narrows `pool` to scenarios carrying at least one of `tagFilter`'s
 * tags (OR semantics — "give me the destructive ones", not "give me the ones tagged both X and Y",
 * which no caller here has needed). Applied AFTER the existing --scenarios/--project filtering
 * (`pool` already reflects both), so `--scenarios a,b --tags destructive` intersects rather than
 * one flag silently overriding the other. Same "empty selection is a hard error" discipline as the
 * existing F4 checks in this file — a typo'd tag must not silently report a zero-scenario PASS. */
function filterByTags(pool, tagFilter, projectId) {
  if (tagFilter === undefined) return pool;
  const tagged = pool.filter((s) => (s.tags ?? []).some((t) => tagFilter.includes(t)));
  if (tagged.length === 0) {
    const known = [...new Set(pool.flatMap((s) => s.tags ?? []))].sort();
    throw new Error(
      `no scenarios match --tags ${tagFilter.join(',')} for project '${projectId}' (after any --scenarios filtering) — ` +
        `refusing to report a zero-scenario run as passing. Known tags in this pool: ${known.join(', ') || '(none)'}`,
    );
  }
  return tagged;
}

async function loadScenarios(filterIds, projectId, tagFilter) {
  const dir = path.join(here, 'scenarios');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const knownProjectIds = await loadKnownProjectIds();
  const all = [];
  for (const f of files) {
    const abs = path.join(dir, f);
    // S-05, promoted to an invariant 2026-08-18: read the SOURCE before importing it. A duplicate
    // object key is legal JavaScript and is gone by the time `import()` resolves — the engine keeps
    // the last binding — so a second `stdoutContains` silently deletes the first assertion and the
    // scenario keeps passing while checking less than it claims. Nothing downstream can see it.
    validateNoDuplicateKeys(fs.readFileSync(abs, 'utf8'), `scenario ${f}`, ts);
    const mod = await import(abs);
    const scenario = mod.default;
    // F1: reject a malformed spec (unknown expect/assert keys, an expect that asserts nothing, an
    // empty-string content check, ...) at LOAD time, for every scenario file that exists on disk —
    // not just the ones this invocation happens to select — so a bad scenario can never run, even
    // partially, regardless of --scenarios/--project filtering.
    validateScenario(scenario);
    // F4 "unmatched scenario" check: a scenario's `project` must name a REAL project, or it's a
    // typo that would otherwise silently drop the scenario out of every run's pool forever,
    // without ever producing an error (loadProject/`--project` only ever loads the project you
    // pass; a typo in a scenario file's `project` field is invisible to that path).
    if (!knownProjectIds.includes(scenario.project)) {
      throw new Error(
        `scenario '${scenario.id}' (${f}) declares project '${scenario.project}', which does not match any known project ` +
          `(${knownProjectIds.join(', ')}) — likely a typo. This is a load-time error so the scenario can't silently vanish from every run's pool.`,
      );
    }
    all.push(scenario);
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
  if (filterIds === undefined) {
    // F4: an empty scenario pool (no scenario file targets `projectId` at all — e.g. a project
    // with no scenarios written for it yet, or every candidate scenario's `project` field is
    // typo'd so it silently dropped out of `forProject` above) must be a hard error. Left
    // unchecked, `main()`'s matrix stays empty, the gate-failure filter over zero rows finds
    // nothing, and the run reports "all scenarios passed" for having done nothing at all.
    if (pool.length === 0) {
      throw new Error(`no scenarios found for project '${projectId}' — refusing to report a zero-scenario run as passing. Known scenarios: ${all.map((s) => `${s.id}(${s.project})`).join(', ') || '(none)'}`);
    }
    return filterByTags(pool, tagFilter, projectId);
  }
  const byId = new Map(pool.map((s) => [s.id, s]));
  const selected = filterIds.map((id) => {
    const s = byId.get(id);
    if (s === undefined) throw new Error(`unknown scenario '${id}' for project '${projectId}' — known: ${[...byId.keys()].join(', ')}`);
    return s;
  });
  return filterByTags(selected, tagFilter, projectId);
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
    ...(step.tool !== undefined ? { tool: step.tool, arguments: step.arguments, expect: step.expect } : {}),
    ...(step.mcpResult !== undefined ? { isError: step.mcpResult.isError, textNormalized: step.mcpResult.textNormalized } : {}),
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
  // F4: a `--gate-target` that matches zero rows of the matrix (a typo, e.g. 'locl' instead of
  // 'local') previously exited 0 unconditionally — the gate-failure filter over zero matching rows
  // finds nothing to fail on, even if every actual target failed. A gate target must be one of the
  // targets this invocation is actually testing.
  if (args.gateTarget !== undefined && !args.targets.includes(args.gateTarget)) {
    throw new Error(`--gate-target '${args.gateTarget}' is not among --targets (${args.targets.join(', ')}) — refusing to run: a gate target matching no results would silently report success.`);
  }
  const gateTarget = args.gateTarget ?? (args.targets.includes('local') ? 'local' : args.targets[0]);
  const cacheRoot = path.join(alignRepoRoot, 'integration', 'results', '.cache');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  // F12: unique per-invocation (runId + pid) tarball cache dir, not a shared `tarballs/` directory
  // — `packLocalTarballs` (lib/version-install.mjs) unconditionally `removeDir`s then repacks its
  // destDir on every 'local' install, so two concurrent `run.mjs` invocations sharing one shared
  // dir would race (one run's removeDir deleting the tarball the other is mid-install from).
  const tarballCacheDir = path.join(cacheRoot, 'tarballs', `${runId}-${process.pid}`);
  const outDir = args.out ?? path.join(alignRepoRoot, 'integration', 'results', runId);
  ensureDir(outDir);

  const log = (msg) => console.log(msg);
  log(
    `[run] runId=${runId} project=${args.project} targets=${args.targets.join(',')} gateTarget=${gateTarget}` +
      (args.tags !== undefined ? ` tags=${args.tags.join(',')}` : ''),
  );
  log(`[run] output: ${outDir}`);

  const project = await loadProject(args.project);
  const scenarios = await loadScenarios(args.scenarios, args.project, args.tags);
  log(`[run] scenarios: ${scenarios.map((s) => s.id).join(', ')}`);

  const basePath = prepareProjectBase(project, cacheRoot, log);

  /** @type {{target: string, scenarioId: string, pass: boolean, errored: boolean}[]} */
  const matrix = [];

  try {
    for (const target of args.targets) {
      for (const scenario of scenarios) {
        const workDir = path.join(cacheRoot, 'work', `${runId}--${target}--${scenario.id}`);
        log(`\n=== ${scenario.id} @ ${target} ===`);
        materializeWorkingCopy(basePath, workDir);

        const result = await runScenario(scenario, { project, target, workingDir: workDir, alignRepoRoot, tarballCacheDir, log });

        const scenarioOutDir = path.join(outDir, target, scenario.id);
        ensureDir(scenarioOutDir);
        // ADR 026: `writeSetCheck` (lib/write-set.mjs, computed once per scenario in
        // lib/scenario-runner.mjs) rides alongside the per-step array rather than being folded into
        // it — it isn't keyed to any one scenario.steps[i], and toNormalizedStep's shape assumes a
        // real step record. Written to every one of the three existing per-scenario artifacts so a
        // write-set violation is diagnosable the same way a step failure already is (raw detail in
        // steps.json, the determinism-check-safe view in normalized.json, the summary in result.json).
        writeJson(path.join(scenarioOutDir, 'steps.json'), { steps: result.steps, writeSetCheck: result.writeSetCheck });
        writeJson(path.join(scenarioOutDir, 'normalized.json'), {
          steps: result.steps.map(toNormalizedStep),
          writeSetCheck: result.writeSetCheck,
        });
        writeJson(path.join(scenarioOutDir, 'result.json'), {
          scenarioId: result.scenarioId,
          target: result.target,
          pass: result.pass,
          errored: result.errored,
          errorMessage: result.errorMessage,
          stepFailures: result.steps.filter((s) => s.pass === false).map((s) => ({ index: s.index, kind: s.kind, failures: s.failures })),
          writeSetCheck: result.writeSetCheck,
        });

        const status = result.errored ? 'ERROR' : result.pass ? 'PASS' : 'FAIL';
        log(`--- ${scenario.id} @ ${target}: ${status} ---`);
        if (status !== 'PASS') {
          if (result.errored) log(`    harness error: ${result.errorMessage}`);
          for (const s of result.steps.filter((s2) => s2.pass === false)) {
            log(`    step ${s.index} (${s.kind}) failed: ${s.failures.join('; ')}`);
          }
          if (result.writeSetCheck !== undefined && !result.writeSetCheck.pass) {
            for (const f of result.writeSetCheck.failures) log(`    ${f}`);
          }
        }

        matrix.push({ target, scenarioId: scenario.id, pass: result.pass, errored: result.errored });

        // Keep the working copy for post-hoc diagnosis on failure (ADR 025 §2) — remove it on
        // success to bound disk usage across a multi-target, multi-scenario run.
        if (result.pass && !args.keepAll) removeDir(workDir);
        else log(`    working copy preserved: ${workDir}`);
      }
    }
  } finally {
    // F12: the tarball cache dir is unique to this invocation (runId + pid) — clean it up
    // unconditionally (success or failure) so `results/.cache/tarballs/` doesn't accumulate one
    // directory per run forever. Packing is always cheap (packLocalTarballs never uses a
    // staleness cache), so there is no reuse value in keeping it around.
    removeDir(tarballCacheDir);
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

  // F3: enforce the red-on-known-buggy-version proof instead of treating it as purely
  // informational. A scenario's `expectFailOn` (e.g. `['0.1.4']` on
  // prune-errored-run-destroys-baseline) names targets it is PINNED to fail against — if one of
  // those targets was actually tested this run and it PASSED, the harness's ability to detect the
  // bug it exists to catch has broken (a normalization change, an F1-style typo, or an actual
  // upstream fix landing in a version this harness still expects to be buggy). This check is
  // independent of `--gate-target`: a calibration break is a harness-integrity failure, not a
  // per-target result, so it fails the run regardless of which target is being gated on.
  const calibrationBreaks = [];
  for (const scenario of scenarios) {
    for (const target of scenario.expectFailOn ?? []) {
      if (!args.targets.includes(target)) continue; // not exercised this run — nothing to check
      const m = matrix.find((m2) => m2.target === target && m2.scenarioId === scenario.id);
      if (m !== undefined && m.pass) calibrationBreaks.push(`${scenario.id}@${target}`);
    }
  }
  if (calibrationBreaks.length > 0) {
    log(
      `\n[run] RED/GREEN CALIBRATION BROKEN: these scenario/target pairs are pinned (via 'expectFailOn') to prove a real bug by ` +
        `going RED, but they PASSED instead: ${calibrationBreaks.join(', ')}. The harness can no longer demonstrate the regression ` +
        `it exists to catch — treat this as a release blocker, not an informational note.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
