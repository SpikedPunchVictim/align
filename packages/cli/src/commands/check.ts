import {
  assertNoCustomHostRules,
  buildMcpCheckPayload,
  renderViolationMessage,
  type CheckRun,
  type ExportedRuleset,
  type InMemoryBaselineStore,
} from '@align/core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, readGeneratedRules, readRulesetIr, readRulesLock, writeBaseline } from '../align-dir.js';
import { verifyFrozenRules } from './build.js';

/** Carried Stage 3 affordance (approved ahead of Stage 4): when generated rules are active
 * (`.align/generated-rules.json` + `.align/rules.lock.json` both present, ADR 011), surface a
 * one-line summary so a human/agent reading `align check` output knows doc-built rules are in
 * force without having to separately inspect `.align/`. Trusted mode only — `--untrusted`'s
 * effective ruleset was already merged into the exported artifact at `align export-ir` time, so
 * re-reading the live `.align/generated-rules.json` here would describe the wrong ruleset (and
 * would be a config-adjacent filesystem read done for cosmetics, not a scan need). */
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
   * the last `align build --apply`. A no-op when `align build` has never run. Mutually exclusive
   * with `untrusted` — frozen-rules verification is a trusted-mode, live-filesystem concern. */
  readonly frozenRules?: boolean;
  /** `align check --untrusted` (alias `--ir-only`, ADR 014): never imports align.config.ts, never
   * invokes any repo-controlled code (no hostRules predicates either — see
   * `assertNoCustomHostRules`). Loads the ruleset from a committed JSON artifact only
   * (`.align/ruleset-ir.json` by default, `ir` below to override), written ahead of time by
   * `align export-ir` in a trusted context. Refuses — never silently falls back to executing the
   * config — when that artifact is missing or contains a `custom.host` rule. */
  readonly untrusted?: boolean;
  /** Overrides the default `.align/ruleset-ir.json` location `--untrusted` reads from. */
  readonly ir?: string;
}

/**
 * `align check` — FRESH scan every run (ADR 005: rescan-on-check, no caching of any kind).
 * Exit 0 only on a fully green verdict (and, with `--frozen-rules`, no doc/generated-rules
 * drift); 1 on red or error (ADR 008: error is environmental and halts/escalates, but from a
 * shell's perspective both are "not safe to proceed"); 1 on a `--untrusted` refuse (missing IR
 * artifact, custom.host present) — refusal is also "not safe to proceed", just before a scan ever
 * starts.
 */
export async function runCheck(rootDir: string, options: CheckOptions): Promise<number> {
  if (options.untrusted === true && options.frozenRules === true) {
    console.error(
      '--untrusted and --frozen-rules cannot be combined: frozen-rules verification reads the live ' +
        'align.config.ts/.align/generated-rules.json/.align/rules.lock.json trio to detect drift, which ' +
        "is exactly the trusted-mode filesystem state --untrusted's committed-IR-only contract excludes. " +
        'Run `align build --verify` (or plain `align check --frozen-rules`) in a trusted checkout instead.',
    );
    return 1;
  }

  return options.untrusted === true ? runUntrustedCheck(rootDir, options) : runTrustedCheck(rootDir, options);
}

async function runTrustedCheck(rootDir: string, options: CheckOptions): Promise<number> {
  const { ruleset, excludes, hostRules } = await loadConfig(rootDir);
  const { orchestrator, baselineStore } = createOrchestrator(ruleset, readBaseline(rootDir), hostRules);

  const run = await orchestrator.check({ rootDir, excludes });
  persistMovedBaseline(rootDir, run, baselineStore);

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

  return emit(effectiveRun, options, generatedRulesSummary(rootDir));
}

/**
 * `align check --untrusted` (ADR 014). Everything above `orchestrator.check` is deliberately
 * different code paths from `runTrustedCheck`, not a shared branch inside it — the whole point is
 * that `loadConfig` (which dynamically imports align.config.ts) is never even referenced in this
 * function's call graph. `hostPredicates` is always the empty map here — safe unconditionally
 * because `assertNoCustomHostRules` below already refused any ruleset that would have needed one.
 */
async function runUntrustedCheck(rootDir: string, options: CheckOptions): Promise<number> {
  let exported: ExportedRuleset | undefined;
  try {
    exported = readRulesetIr(rootDir, options.ir);
  } catch (err) {
    console.error(
      `align check --untrusted: ${err instanceof Error ? err.message : String(err)} — refusing to run. ` +
        'A corrupted or hand-edited IR artifact is never treated as absent (that would silently drop ' +
        'rules); re-run `align export-ir` in a trusted checkout to regenerate it.',
    );
    return 1;
  }
  if (exported === undefined) {
    const path = options.ir ?? '.align/ruleset-ir.json';
    console.error(
      `align check --untrusted: no committed IR ruleset found at ${path}. --untrusted cannot execute ` +
        'align.config.ts, so there is nothing to check it against. Run `align export-ir` in a trusted ' +
        'checkout to produce it, or run `align check` without --untrusted only on repos you trust to ' +
        'execute code.',
    );
    return 1;
  }

  try {
    assertNoCustomHostRules(exported.ruleset.rules);
  } catch (err) {
    console.error(`align check --untrusted: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { orchestrator, baselineStore } = createOrchestrator(exported.ruleset, readBaseline(rootDir), new Map());
  const run = await orchestrator.check({ rootDir, excludes: exported.excludes });
  persistMovedBaseline(rootDir, run, baselineStore);

  return emit(run, options, undefined);
}

function persistMovedBaseline(rootDir: string, run: CheckRun, baselineStore: InMemoryBaselineStore): void {
  // Move-transfer (ADR 006) mutated the in-memory store during `check` — persist so a rename
  // doesn't need a separate `align baseline prune` run to stop being reported every time.
  if (run.advisories.some((a) => a.kind === 'baseline-moved')) {
    writeBaseline(rootDir, baselineStore.snapshot());
  }
}

function emit(
  run: CheckRun,
  options: CheckOptions,
  generatedRules: { readonly count: number; readonly doc: string; readonly builtAt: string } | undefined,
): number {
  if (options.json) {
    const payload = buildMcpCheckPayload(run);
    const withGeneratedRules = generatedRules === undefined ? payload : { ...payload, generatedRules: { ...generatedRules } };
    process.stdout.write(`${JSON.stringify(withGeneratedRules, null, 2)}\n`);
    return run.verdict === 'green' ? 0 : 1;
  }

  printHuman(run, generatedRules);
  return run.verdict === 'green' ? 0 : 1;
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
