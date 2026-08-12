// Executes one scenario (ADR 025 §3's data shape) against one target version, in one working
// copy. Pure orchestration — every actual decision (what a command does, whether an expectation
// holds) lives in exec.mjs / capture.mjs / assert.mjs; this file just walks the step list.
import { runAlign } from './exec.mjs';
import { captureState, normalizeRunResult } from './capture.mjs';
import { evaluateExpect, evaluateAssert, evaluateMcpExpect } from './assert.mjs';
import { applyMutation } from './mutations.mjs';
import { installAlignVersion } from './version-install.mjs';
import { callMcpTool } from './mcp-client.mjs';
import { snapshotTree, checkWriteSet, checkMarkerOwnedRegion, MARKER_OWNED_FILES } from './write-set.mjs';

/** Reads the marker-owned file's raw text out of a step's captured state (`lib/capture.mjs`'s
 * `captureState` output) — `align.config.ts`'s FULL raw text is already captured there;
 * `CLAUDE.md`'s full raw text is `claudeMdFull` (added specifically to close ADR 026's named gap —
 * see that field's doc comment in capture.mjs). Returns `undefined` when the file is absent. */
function rawMarkerFileText(state, relPath) {
  if (relPath === 'align.config.ts') return state.alignConfig.present ? state.alignConfig.raw : undefined;
  if (relPath === 'CLAUDE.md') return state.claudeMdFull.present ? state.claudeMdFull.raw : undefined;
  throw new Error(`rawMarkerFileText: unrecognized marker-owned file '${relPath}'`);
}

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

  // ADR 026: "a command may only touch what it declares." `writeSetDeclared` defaults to `[]`
  // (fail-closed, ADR 026 Decision) — a scenario that never declares a `writeSet` field permits
  // NOTHING to change, so a new scenario fails loudly until its author states what the command
  // sequence is licensed to touch, rather than silently passing.
  const writeSetDeclared = scenario.writeSet ?? [];
  const markerFilesDeclared = Object.keys(MARKER_OWNED_FILES).filter((f) => writeSetDeclared.includes(f));
  // Bracket the WHOLE scenario's command sequence with one snapshot before the first step and one
  // after the last (ADR 026 Decision: "Each command sequence is bracketed by a snapshot of every
  // path under the project root") — a single before/after pair, not one per step, because the
  // whole-tree walk is the expensive half of this invariant and ADR 026 promises it "costs
  // approximately nothing at runtime"; two walks per scenario is cheap, `steps.length` walks is not.
  const treeBefore = snapshotTree(workingDir);

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
          alignOnlyInstall: project.alignOnlyInstall === true,
          log,
        });
        record = { index: i, kind: 'install', requested: step.install, resolvedVersion: version, installedVersion, pass: true, failures: [] };
      } else if (step.run !== undefined) {
        log(`[${scenario.id}/${target}] step ${i}: run ${step.run}`);
        const raw = runAlign(workingDir, step.run);
        const normalized = normalizeRunResult(raw, workingDir, { keepVersion: step.keepVersion === true });
        const { pass, failures } = evaluateExpect(step.expect, normalized);
        record = { index: i, kind: 'run', command: step.run, expect: step.expect, result: normalized, pass, failures };
      } else if (step.mcpCall !== undefined) {
        log(`[${scenario.id}/${target}] step ${i}: mcpCall ${step.mcpCall.tool}`);
        const mcpResult = await callMcpTool(workingDir, step.mcpCall.tool, step.mcpCall.arguments, { keepVersion: step.keepVersion === true });
        const { pass, failures } = evaluateMcpExpect(step.expect, mcpResult);
        record = { index: i, kind: 'mcpCall', tool: step.mcpCall.tool, arguments: step.mcpCall.arguments, expect: step.expect, mcpResult, pass, failures };
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
        throw new Error(`step ${i} of scenario '${scenario.id}' has no recognized action (install/run/mutate/snapshot/assert/mcpCall)`);
      }

      const stateAfter = captureState(workingDir);
      if (step.snapshot !== undefined) snapshots.set(step.snapshot, stateAfter);

      // ADR 026's content-aware clause, evaluated PER STEP (not just once for the whole scenario —
      // see `lib/write-set.mjs`'s `checkMarkerOwnedRegion` doc comment for why: BUG #10's own
      // reproduction is two runs of `align init` within ONE scenario, so only a per-command
      // before/after comparison can catch a LATER command corrupting content an EARLIER command in
      // the same scenario already established). Only evaluated for a marker-owned file the scenario
      // actually declared writable — an undeclared file is already fully protected by the coarser
      // whole-tree `checkWriteSet` below (any change to it at all is unauthorized), so this
      // narrower check would be redundant there.
      //
      // Restricted to `run`/`mcpCall` steps — i.e. an actual ALIGN COMMAND invocation — never
      // `mutate` steps. `mutate` is the harness's OWN test scaffolding (lib/mutations.mjs:
      // "Each mutation is a pure filesystem edit against a working copy's align.config.ts"), and
      // several existing mutations deliberately rewrite content outside the marker block on
      // purpose — `corrupt-config` replaces the whole file, `introduce-arch-violation`/`add-no-
      // cycles-rule`/`shadow-component` all edit `rules`/`components`. ADR 026's content-aware
      // clause exists to catch ALIGN's own marker-splice code corrupting the surrounding content
      // when ALIGN runs a command (BUG #10); it was never meant to forbid the harness's own fixture
      // setup from editing the file it explicitly owns for the duration of the scenario.
      if (record.kind === 'run' || record.kind === 'mcpCall') {
        for (const relPath of markerFilesDeclared) {
          const { pass, failures } = checkMarkerOwnedRegion(relPath, rawMarkerFileText(stateBefore, relPath), rawMarkerFileText(stateAfter, relPath));
          if (!pass) {
            record.pass = false;
            record.failures = [...record.failures, ...failures];
          }
        }
      }

      steps.push({ ...record, stateBefore, stateAfter });
      if (record.pass === false) overallPass = false;
    }

    // ADR 026's primary invariant, bracketing the whole command sequence (see `treeBefore` above).
    // Computed even when a declared step failed above — a scenario whose `run`/`assert` expectation
    // didn't hold can still, independently, have touched paths it never declared, and both facts
    // are worth reporting rather than the second being silently skipped because the first already
    // failed the scenario.
    const treeAfter = snapshotTree(workingDir);
    const writeSetCheck = checkWriteSet(treeBefore, treeAfter, scenario.writeSet);
    if (!writeSetCheck.pass) overallPass = false;

    return { scenarioId: scenario.id, target, pass: overallPass, errored: false, steps, writeSetCheck };
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
