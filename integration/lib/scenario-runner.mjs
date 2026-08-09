// Executes one scenario (ADR 025 §3's data shape) against one target version, in one working
// copy. Pure orchestration — every actual decision (what a command does, whether an expectation
// holds) lives in exec.mjs / capture.mjs / assert.mjs; this file just walks the step list.
import { runAlign } from './exec.mjs';
import { captureState, normalizeRunResult } from './capture.mjs';
import { evaluateExpect, evaluateAssert } from './assert.mjs';
import { applyMutation } from './mutations.mjs';
import { installAlignVersion } from './version-install.mjs';

/** Resolves a scenario's `install:` value — the literal sentinel `'target'` means "whatever
 * version this invocation is testing" (the mechanism that lets one scenario file express its
 * expected/correct behavior ONCE and be run against several concrete versions — see
 * `integration/README.md`'s "why 'target'" section). Anything else is a literal version, for the
 * (increment-2+) scenarios that genuinely install a second, DIFFERENT version mid-flow (e.g. an
 * upgrade scenario that always starts at a fixed old version regardless of what's under test). */
function resolveVersion(installValue, target) {
  return installValue === 'target' ? target : installValue;
}

/**
 * Runs every step of `scenario` in `workingDir` against `target`, returning a full result record.
 * Never throws on a declarative mismatch (a step's `expect`/`assert` not holding) — that is a
 * normal, expected outcome the caller reports as a scenario FAIL, distinguished from an
 * `errored: true` result, which means the harness itself could not execute the scenario (a
 * process launch failure, an install that genuinely failed, an unknown mutation/assert name) and
 * is always a bug in the harness or its environment, never a statement about align.
 */
export async function runScenario(scenario, ctx) {
  const { project, target, workingDir, log = () => {} } = ctx;
  const snapshots = new Map();
  const steps = [];
  let overallPass = true;

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const stateBefore = captureState(workingDir);
      let record;

      if (step.install !== undefined) {
        const version = resolveVersion(step.install, target);
        log(`[${scenario.id}/${target}] step ${i}: install ${version}`);
        const { installedVersion } = installAlignVersion(workingDir, version, {
          alignRepoRoot: ctx.alignRepoRoot,
          tarballCacheDir: ctx.tarballCacheDir,
          log,
        });
        record = { index: i, kind: 'install', requested: step.install, resolvedVersion: version, installedVersion, pass: true, failures: [] };
      } else if (step.run !== undefined) {
        log(`[${scenario.id}/${target}] step ${i}: run ${step.run}`);
        const raw = runAlign(workingDir, step.run);
        const normalized = normalizeRunResult(raw, workingDir);
        const { pass, failures } = evaluateExpect(step.expect, normalized);
        record = { index: i, kind: 'run', command: step.run, expect: step.expect, result: normalized, pass, failures };
      } else if (step.mutate !== undefined) {
        log(`[${scenario.id}/${target}] step ${i}: mutate ${step.mutate}`);
        applyMutation(step.mutate, { workingDir, project });
        record = { index: i, kind: 'mutate', name: step.mutate, pass: true, failures: [] };
      } else if (step.snapshot !== undefined) {
        log(`[${scenario.id}/${target}] step ${i}: snapshot '${step.snapshot}'`);
        record = { index: i, kind: 'snapshot', label: step.snapshot, pass: true, failures: [] };
      } else if (step.assert !== undefined) {
        log(`[${scenario.id}/${target}] step ${i}: assert ${step.assert.kind}`);
        const { pass, failures, before, after } = evaluateAssert(step.assert, snapshots, stateBefore);
        record = { index: i, kind: 'assert', spec: step.assert, pass, failures, before, after };
      } else {
        throw new Error(`step ${i} of scenario '${scenario.id}' has no recognized action (install/run/mutate/snapshot/assert)`);
      }

      const stateAfter = captureState(workingDir);
      if (step.snapshot !== undefined) snapshots.set(step.snapshot, stateAfter);

      steps.push({ ...record, stateBefore, stateAfter });
      if (record.pass === false) overallPass = false;
    }
    return { scenarioId: scenario.id, target, pass: overallPass, errored: false, steps };
  } catch (err) {
    return {
      scenarioId: scenario.id,
      target,
      pass: false,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
      steps,
    };
  }
}
