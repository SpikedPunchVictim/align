import { buildMcpCheckPayload, renderViolationMessage, type CheckRun } from '@align/core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, writeBaseline } from '../align-dir.js';
import { verifyFrozenRules } from './build.js';

export interface CheckOptions {
  readonly json: boolean;
  /** `align check --frozen-rules` (ADR 011): also red if a doc-built ruleset has drifted from its
   * lockfile (doc edited but not rebuilt) or `.align/generated-rules.json` was hand-edited since
   * the last `align build --apply`. A no-op when `align build` has never run. */
  readonly frozenRules?: boolean;
}

/**
 * `align check` — FRESH scan every run (ADR 005: rescan-on-check, no caching of any kind).
 * Exit 0 only on a fully green verdict (and, with `--frozen-rules`, no doc/generated-rules
 * drift); 1 on red or error (ADR 008: error is environmental and halts/escalates, but from a
 * shell's perspective both are "not safe to proceed").
 */
export async function runCheck(rootDir: string, options: CheckOptions): Promise<number> {
  const { ruleset, excludes } = await loadConfig(rootDir);
  const { orchestrator, baselineStore } = createOrchestrator(ruleset, readBaseline(rootDir));

  const run = await orchestrator.check({ rootDir, excludes });

  // Move-transfer (ADR 006) mutated the in-memory store during `check` — persist so a rename
  // doesn't need a separate `align baseline prune` run to stop being reported every time.
  if (run.advisories.some((a) => a.kind === 'baseline-moved')) {
    writeBaseline(rootDir, baselineStore.snapshot());
  }

  let effectiveRun = run;
  let frozenRulesOk = true;
  if (options.frozenRules === true) {
    const frozen = verifyFrozenRules(rootDir);
    frozenRulesOk = frozen.ok;
    effectiveRun = { ...run, advisories: [...run.advisories, ...frozen.advisories] };
  }

  if (options.json) {
    const payload = buildMcpCheckPayload(effectiveRun);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return effectiveRun.verdict === 'green' && frozenRulesOk ? 0 : 1;
  }

  printHuman(effectiveRun);
  return effectiveRun.verdict === 'green' && frozenRulesOk ? 0 : 1;
}

function printHuman(run: CheckRun): void {
  for (const gate of run.gates) {
    const label = `${gate.gate}`.padEnd(12);
    if (gate.status === 'error') {
      console.log(`  ${label} ERROR   ${gate.errorMessage ?? ''}`);
      continue;
    }
    if (gate.status === 'skipped') {
      console.log(`  ${label} skipped`);
      continue;
    }
    const suffix = gate.baselinedCount > 0 ? ` (${gate.baselinedCount} baselined)` : '';
    console.log(`  ${label} ${gate.status === 'green' ? 'green ' : 'RED   '} ${gate.violations.length} violation(s)${suffix}`);
  }

  const violations = run.gates.flatMap((g) => g.violations);
  if (violations.length > 0) {
    console.log('');
    for (const v of violations) {
      console.log(`  ${v.file}:${v.range.startLine} [${v.ruleId}] ${renderViolationMessage(v)}`);
    }
  }

  console.log('');
  if (run.advisories.length > 0) {
    for (const a of run.advisories) console.log(`  advisory (${a.kind}): ${a.message}`);
  }
  console.log(`verdict: ${run.verdict}`);
}
