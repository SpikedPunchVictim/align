import { buildMcpCheckPayload, renderViolationMessage, type CheckRun } from '@align/core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, readGeneratedRules, readRulesLock, writeBaseline } from '../align-dir.js';
import { verifyFrozenRules } from './build.js';

/** Carried Stage 3 affordance (approved ahead of Stage 4): when generated rules are active
 * (`.align/generated-rules.json` + `.align/rules.lock.json` both present, ADR 011), surface a
 * one-line summary so a human/agent reading `align check` output knows doc-built rules are in
 * force without having to separately inspect `.align/`. */
function generatedRulesSummary(rootDir: string): { readonly count: number; readonly doc: string; readonly builtAt: string } | undefined {
  const generated = readGeneratedRules(rootDir);
  const lock = readRulesLock(rootDir);
  if (generated === undefined || lock === undefined || generated.rules.length === 0) return undefined;
  return { count: generated.rules.length, doc: lock.docPath, builtAt: new Date(lock.builtAt).toISOString().slice(0, 10) };
}

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
  if (options.frozenRules === true) {
    const frozen = verifyFrozenRules(rootDir);
    effectiveRun = {
      ...run,
      // A false 'green' verdict is a severity-zero bug class (ARCHITECTURE.md's stated
      // invariant) — drift/divergence must flip the VERDICT ITSELF, not just the exit code, so
      // `--json` consumers (agents, CI) reading `verdict` alone never get a lying "green" while
      // `advisories` quietly explains why they shouldn't have trusted it.
      verdict: !frozen.ok && run.verdict === 'green' ? 'red' : run.verdict,
      advisories: [...run.advisories, ...frozen.advisories],
    };
  }

  const generatedRules = generatedRulesSummary(rootDir);

  if (options.json) {
    const payload = buildMcpCheckPayload(effectiveRun);
    const withGeneratedRules =
      generatedRules === undefined ? payload : { ...payload, generatedRules: { ...generatedRules } };
    process.stdout.write(`${JSON.stringify(withGeneratedRules, null, 2)}\n`);
    return effectiveRun.verdict === 'green' ? 0 : 1;
  }

  printHuman(effectiveRun, generatedRules);
  return effectiveRun.verdict === 'green' ? 0 : 1;
}

function printHuman(run: CheckRun, generatedRules?: { readonly count: number; readonly doc: string; readonly builtAt: string }): void {
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

  if (generatedRules !== undefined) {
    console.log(`  +${generatedRules.count} rules from ${generatedRules.doc} (built ${generatedRules.builtAt})`);
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
