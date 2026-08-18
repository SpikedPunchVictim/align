import {
  assertNoCustomHostRules,
  buildMcpCheckPayload,
  isRunComplete,
  renderViolationMessage,
  type BaselineDebt,
  type BaselineEntry,
  type CheckRun,
  type ExportedRuleset,
  type FileExistenceProbe,
  type InMemoryBaselineStore,
  type RepoRelativePath,
} from '@spikedpunch/align-core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, readGeneratedRules, readRulesetIr, readRulesLock, writeBaseline } from '../align-dir.js';
import { reportCliError } from '../cli-error.js';
import { verifyFrozenRules } from './build.js';
import { buildCheckEvent, computeAndPersistViolationTransitions, computeRulesetIrHash, createTelemetryRecorder } from '../telemetry/index.js';
import { withVersionSkew } from '../version-skew.js';
import { partitionBlindSpotCandidates } from '../scan-blind-spot-retention.js';
import { createFileExistenceProbe } from '../file-existence.js';

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
  /** The CLI-flag/env half of the telemetry enable precedence, already resolved by `program.ts`
   * (`resolveTelemetryPreConfig`) — `undefined` means "flags/env didn't decide, defer to
   * `align.config.ts`'s `telemetry` export" (never read under `--untrusted`, ADR 014). */
  readonly telemetryPreConfig?: boolean;
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
  // `loadConfig` can fail six different ways — a syntax error in align.config.ts, a missing
  // @spikedpunch/align-core devDependency, a missing default export, a malformed excludes/
  // compositionRoots/knownPublicDeepImports export, or a corrupt `.align/generated-rules.json`
  // (bug hunt 2026-08-03, BUG #14) — and nothing between here and `program.ts`'s action handler
  // used to catch any of them, so every one crashed with a raw Node stack trace.
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(rootDir);
  } catch (err) {
    return reportCliError('align check', err);
  }
  const { ruleset, excludes, hostRules, telemetry, includeNestedCheckouts } = loaded;
  let previousBaseline: BaselineEntry[];
  try {
    previousBaseline = readBaseline(rootDir);
  } catch (err) {
    // readBaseline throws on a corrupted `.align/baseline.json` (bug hunt 2026-08-03, BUG #1) —
    // caught here the same way `runUntrustedCheck` below catches `readRulesetIr`, instead of an
    // unattributed Node stack trace.
    return reportCliError('align check', err);
  }
  const { orchestrator, baselineStore } = createOrchestrator(rootDir, ruleset, previousBaseline, hostRules);

  const recorder = createTelemetryRecorder(rootDir, 'check', options.telemetryPreConfig, telemetry);
  const rulesetIrHash = computeRulesetIrHash(ruleset);

  const wallStart = performance.now();
  const run = await orchestrator.check({ rootDir, excludes, includeNestedCheckouts });
  const wallMs = performance.now() - wallStart;
  try {
    // Writes `.align/baseline.json` on a move-transfer, which stamps `alignVersion` (ADR 022's
    // write discipline, `align-dir.ts`) and can throw on a corrupted `.align/version.json` — same
    // corrupt-≠-absent discipline as `readBaseline`'s catch above, reported the same clean way
    // rather than an unhandled Node stack trace.
    persistMovedBaseline(rootDir, run, baselineStore);
  } catch (err) {
    return reportCliError('align check', err);
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

  recordCheckTelemetry(rootDir, recorder, effectiveRun, wallMs, rulesetIrHash, 'check');

  let finalRun: CheckRun;
  try {
    // Reads `.align/version.json` for the provenance advisory (ADR 021/022, `version-skew.ts`) and
    // can throw on a corrupted file — same discipline, reported the same clean way.
    finalRun = withVersionSkew(effectiveRun, rootDir);
  } catch (err) {
    return reportCliError('align check', err);
  }
  return emit(finalRun, options, generatedRulesSummary(rootDir), computeBaselineDebt(previousBaseline, run, createFileExistenceProbe(rootDir)));
}

/**
 * The one place `check`'s telemetry gets recorded (both trusted and `--untrusted` paths funnel
 * through this) — a `check` event unconditionally, plus one `violation-appeared`/
 * `violation-resolved` event per fingerprint transition against `.align/telemetry-state.json`
 * (only computed/persisted when the recorder is actually enabled — an OFF run must never touch
 * that file, IMPLEMENTATION_PLAN.md's telemetry spec). An `error`/`gate-error` event replaces the
 * `check` event when the verdict itself is `'error'` (a gate genuinely couldn't produce a
 * trustworthy result — ADR 008), since a latency/violation-count number for a run that didn't
 * really complete would misrepresent the distribution the summarizer command computes.
 */
function recordCheckTelemetry(
  rootDir: string,
  recorder: ReturnType<typeof createTelemetryRecorder>,
  run: CheckRun,
  wallMs: number,
  rulesetIrHash: string | undefined,
  command: string,
): void {
  if (!recorder.enabled) return;

  if (run.verdict === 'error') {
    const errorGate = run.gates.find((g) => g.status === 'error');
    recorder.record(
      { kind: 'error', errorKind: 'gate-error', message: shortMessage(errorGate?.errorMessage ?? 'unknown gate error'), command },
      { ...(rulesetIrHash !== undefined ? { rulesetIrHash } : {}) },
    );
    return;
  }

  recorder.record(buildCheckEvent(run, wallMs), { ...(rulesetIrHash !== undefined ? { rulesetIrHash } : {}) });

  const violations = run.gates.flatMap((g) => g.violations);
  for (const event of computeAndPersistViolationTransitions(rootDir, violations)) {
    recorder.record(event, { ...(rulesetIrHash !== undefined ? { rulesetIrHash } : {}) });
  }
}

/** SHORT message only — no secrets, no file contents (IMPLEMENTATION_PLAN.md's telemetry spec).
 * `errorMessage` on a `GateResult` is already environmental/plain-string (never LLM-facing prose
 * embedding source text, `gates/types.ts`), but is truncated defensively here anyway since it can
 * originate from an arbitrary thrown `Error`'s `.message`. */
function shortMessage(message: string, maxLength = 200): string {
  return message.length > maxLength ? `${message.slice(0, maxLength)}…` : message;
}

/**
 * `align check --untrusted` (ADR 014). Everything above `orchestrator.check` is deliberately
 * different code paths from `runTrustedCheck`, not a shared branch inside it — the whole point is
 * that `loadConfig` (which dynamically imports align.config.ts) is never even referenced in this
 * function's call graph. `hostPredicates` is always the empty map here — safe unconditionally
 * because `assertNoCustomHostRules` below already refused any ruleset that would have needed one.
 */
async function runUntrustedCheck(rootDir: string, options: CheckOptions): Promise<number> {
  // Built before the IR artifact is even read, from flags/`ALIGN_TELEMETRY` only — `--untrusted`
  // never calls `loadConfig` (ADR 014), so `align.config.ts`'s `telemetry` export can never
  // contribute to this decision under this mode, by the same design that keeps `hostRules` out of
  // reach here. This lets a refusal itself be recorded (`untrusted-refusal`) below.
  const recorder = createTelemetryRecorder(rootDir, 'check --untrusted', options.telemetryPreConfig, undefined);

  let exported: ExportedRuleset | undefined;
  try {
    exported = readRulesetIr(rootDir, options.ir);
  } catch (err) {
    const message = `${err instanceof Error ? err.message : String(err)} — refusing to run. A corrupted or ` +
      'hand-edited IR artifact is never treated as absent (that would silently drop rules); re-run ' +
      '`align export-ir` in a trusted checkout to regenerate it.';
    console.error(`align check --untrusted: ${message}`);
    recorder.record({ kind: 'error', errorKind: 'untrusted-refusal', message: shortMessage(message), command: 'check --untrusted' });
    return 1;
  }
  if (exported === undefined) {
    const path = options.ir ?? '.align/ruleset-ir.json';
    const message =
      `no committed IR ruleset found at ${path}. --untrusted cannot execute align.config.ts, so there is ` +
      'nothing to check it against. Run `align export-ir` in a trusted checkout to produce it, or run ' +
      '`align check` without --untrusted only on repos you trust to execute code.';
    console.error(`align check --untrusted: ${message}`);
    recorder.record({ kind: 'error', errorKind: 'untrusted-refusal', message: shortMessage(message), command: 'check --untrusted' });
    return 1;
  }

  try {
    assertNoCustomHostRules(exported.ruleset.rules);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`align check --untrusted: ${message}`);
    recorder.record({ kind: 'error', errorKind: 'untrusted-refusal', message: shortMessage(message), command: 'check --untrusted' });
    return 1;
  }

  const rulesetIrHash = computeRulesetIrHash(exported.ruleset);
  let previousBaseline: BaselineEntry[];
  try {
    previousBaseline = readBaseline(rootDir);
  } catch (err) {
    // Same discipline as the `readRulesetIr` catch above — a corrupted `.align/baseline.json`
    // (bug hunt 2026-08-03, BUG #1) is a refusal, not a raw Node stack trace.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`align check --untrusted: ${message}`);
    recorder.record({ kind: 'error', errorKind: 'untrusted-refusal', message: shortMessage(message), command: 'check --untrusted' });
    return 1;
  }
  const { orchestrator, baselineStore } = createOrchestrator(rootDir, exported.ruleset, previousBaseline, new Map());
  const wallStart = performance.now();
  const run = await orchestrator.check({ rootDir, excludes: exported.excludes, includeNestedCheckouts: exported.includeNestedCheckouts });
  const wallMs = performance.now() - wallStart;
  try {
    // Same corrupt-≠-absent risk (a move-transfer write stamps `alignVersion`, ADR 022) as
    // `runTrustedCheck`'s identical catch above.
    persistMovedBaseline(rootDir, run, baselineStore);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`align check --untrusted: ${message}`);
    recorder.record({ kind: 'error', errorKind: 'untrusted-refusal', message: shortMessage(message), command: 'check --untrusted' });
    return 1;
  }

  recordCheckTelemetry(rootDir, recorder, run, wallMs, rulesetIrHash, 'check --untrusted');

  let finalRun: CheckRun;
  try {
    // Same corrupt-≠-absent risk (reads `.align/version.json` for the provenance advisory) as
    // `runTrustedCheck`'s identical catch above.
    finalRun = withVersionSkew(run, rootDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`align check --untrusted: ${message}`);
    recorder.record({ kind: 'error', errorKind: 'untrusted-refusal', message: shortMessage(message), command: 'check --untrusted' });
    return 1;
  }
  return emit(finalRun, options, undefined, computeBaselineDebt(previousBaseline, run, createFileExistenceProbe(rootDir)));
}

/** Exported so `align upgrade` (`commands/upgrade.ts`, ADR 022) can reuse this exact move-transfer
 * persistence instead of a second copy — its own initial scan needs the identical "always persist a
 * rename, never gate it on consent" behavior a plain `align check` already has (ADR 006: a rename
 * must not turn CI red for one cycle, and ADR 023's "transfer-only" exemption deliberately does not
 * call `refuseIfRunErrored` here either — see this function's own logic below). */
export function persistMovedBaseline(rootDir: string, run: CheckRun, baselineStore: InMemoryBaselineStore): void {
  // Move-transfer (ADR 006) mutated the in-memory store during `check` — persist so a rename
  // doesn't need a separate `align baseline prune` run to stop being reported every time.
  if (run.advisories.some((a) => a.kind === 'baseline-moved')) {
    writeBaseline(rootDir, baselineStore.snapshot());
  }
}

/** The one baseline-debt computation shared by `align check`, MCP `align_check`, and the payload
 * builder's fallback — a single guarded function so the error-run correction (below) can't drift
 * across copies (it did: three inline `Σ baselinedCount` sites, and only two were first fixed).
 *
 * `builder.ts`'s `fallbackBaselineDebt` is deliberately NOT a fourth instance of either defect and
 * needs no change: it has no previous baseline to compare against, sets `previous = current`, and
 * therefore can never report a drop at all. Checked 2026-08-18 while fixing D016, and recorded so
 * the next reader auditing this class does not have to check it twice.
 * The same asymmetry has a MUTATING half — commands that delete/overwrite baseline entries from a
 * run's violations (`baseline prune`, `init`) — guarded by `refuseIfRunErrored` (`errored-run.ts`),
 * which is where a new consumer of flattened gate violations should look first. */
export function computeBaselineDebt(
  previousBaseline: readonly BaselineEntry[],
  run: CheckRun,
  fileExists: FileExistenceProbe,
): BaselineDebt {
  const previous = previousBaseline.length;
  // TIER 1 — an errored gate reports `baselinedCount: 0` (orchestrator.ts) though its on-disk
  // baseline entries still exist, so summing on an error run fabricates a debt DROP (`47 → 0
  // (−47)`) exactly when nothing was verified — a false "debt eliminated" ratchet signal in human +
  // JSON + MCP output. The ratchet only moves on a fully-evaluated scan (any errored gate ⇒
  // `verdict:'error'`, deriveVerdict); otherwise report no change (current = previous, delta 0).
  //
  // Ordered before tier 2 deliberately: an errored run evaluated no rule anywhere, so there is no
  // sound per-entry statement to make about it, and the coarser answer is the only honest one.
  if (run.verdict === 'error') return { previous, current: previous, delta: 0 };

  // TIER 2 (LEDGER D016) — the SECOND cause of the identical fabrication, introduced by ADR 028 and
  // missed when tier 1 was written. Shape S-09, *fixed one arm, missed the other*: an entry whose
  // file this scan could not observe produces no current violation, so it contributes 0 to the sum
  // below in exactly the way a genuinely fixed one does. Measured against the built binary before
  // this fix — two accepted entries behind one `excludes` pattern reported `baselined debt: 2 → 0
  // (-2)`, verdict green, exit 0, with both entries still on disk and nothing fixed, while `prune`
  // on the same state correctly reported `Retained 2 entries`.
  //
  // COUNTED AS STILL-BASELINED rather than suppressing the line, and that is the whole design.
  // Suppression (report no change whenever anything is unobservable) is the obvious move and it is
  // shape S-04, *a guard correct in the unsafe direction and wrong in the safe one*: with 500
  // entries, 2 hidden and 10 genuinely fixed, it would hide a real 10-entry paydown to avoid a
  // 2-entry error. An unobservable entry is not paid-off debt; it is debt align could not look at,
  // which is precisely what `prune` already does with the same entries through the same partition.
  // Reusing `partitionBlindSpotCandidates` is what keeps this reporting path and that destructive
  // path from disagreeing again — the disagreement WAS the defect.
  //
  // The pre-filter on `!observed.has(...)` guarantees no double counting: every entry added back
  // here is one no gate could have counted. It is not an optimisation, and removing it would let a
  // still-violating entry be counted twice.
  const observed: ReadonlySet<RepoRelativePath> = new Set([...run.observedFiles.source, ...run.observedFiles.manifest]);
  const unobserved = previousBaseline.filter((entry) => !observed.has(entry.file));
  const unobservable = partitionBlindSpotCandidates(unobserved, run.blindSpots, observed, fileExists).retained.length;

  const matched = run.gates.reduce((sum, g) => sum + g.baselinedCount, 0);
  const current = matched + unobservable;
  return { previous, current, delta: current - previous };
}

function emit(
  run: CheckRun,
  options: CheckOptions,
  generatedRules: { readonly count: number; readonly doc: string; readonly builtAt: string } | undefined,
  baselineDebt: BaselineDebt,
): number {
  if (options.json) {
    const payload = buildMcpCheckPayload(run, { baselineDebt });
    const withGeneratedRules = generatedRules === undefined ? payload : { ...payload, generatedRules: { ...generatedRules } };
    process.stdout.write(`${JSON.stringify(withGeneratedRules, null, 2)}\n`);
    return run.verdict === 'green' ? 0 : 1;
  }

  printHuman(run, generatedRules, baselineDebt);
  return run.verdict === 'green' ? 0 : 1;
}

/** Word-wrap `text` to the terminal width, prefixing every line with `indent` spaces. Keeps long
 * violation/advisory prose readable instead of one jumbled wrapped line (machines use `--json`).
 * Exported for unit testing (pure). */
export function wrapMessage(text: string, indent: number): string[] {
  const width = Math.max(40, Math.min(process.stdout.columns ?? 100, 120)) - indent;
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur === '') cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      lines.push(pad + cur);
      cur = word;
    }
  }
  if (cur !== '') lines.push(pad + cur);
  return lines;
}

function printHuman(
  run: CheckRun,
  generatedRules?: { readonly count: number; readonly doc: string; readonly builtAt: string },
  baselineDebt?: BaselineDebt,
): void {
  for (const gate of run.gates) {
    const label = `${gate.gate}`.padEnd(12);
    if (gate.status === 'error') {
      console.log(`  ${label} ERROR`);
      for (const line of wrapMessage(gate.errorMessage ?? 'unknown error', 4)) console.log(line);
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

  // Detail section — grouped by gate, each violation as a scannable header (location + rule id)
  // followed by its word-wrapped message. Machines should read `--json` instead.
  for (const gate of run.gates) {
    if (gate.violations.length === 0) continue;
    console.log('');
    console.log(`  ${gate.gate} — ${gate.violations.length} violation(s)`);
    for (const v of gate.violations) {
      console.log('');
      console.log(`    ✗ ${v.file}:${v.range.startLine}  ${v.ruleId}`);
      for (const line of wrapMessage(renderViolationMessage(v), 6)) console.log(line);
    }
  }

  if (run.advisories.length > 0) {
    console.log('');
    for (const a of run.advisories) {
      const wrapped = wrapMessage(`advisory (${a.kind}): ${a.message}`, 2);
      for (const line of wrapped) console.log(line);
    }
  }
  console.log('');
  // R1 (greenfield mode): a distinct line near the verdict — not buried in `align explain`/
  // `doctor` — so a check-agent's own loop sees "green because compliant" vs. "green because
  // empty" as different states (registry.ts's `findUngroundedComponents` doc comment names the
  // false-green hole this closes).
  if (run.ungroundedComponents.length > 0) {
    const names = run.ungroundedComponents.map((c) => c.name).join(', ');
    console.log(
      `⚠ ${run.ungroundedComponents.length} component(s) matched no files (ungrounded, provisionally green): ${names}`,
    );
  }
  // Suppress the ratchet trailer on an error run — the verdict is the headline, and the debt delta
  // is unmeasurable (computeBaselineDebt reports no-change there anyway; printing `47 → 47 (0)`
  // under a hard error is just noise).
  if (baselineDebt !== undefined && run.verdict !== 'error') {
    const deltaStr = baselineDebt.delta === 0 ? '0' : `${baselineDebt.delta > 0 ? '+' : ''}${baselineDebt.delta}`;
    console.log(`baselined debt: ${baselineDebt.previous} → ${baselineDebt.current} (${deltaStr})`);
  }
  // Provisional when the graph was built without the repo's external deps (a missing-dependencies
  // advisory fired) — mirrors the payload `complete: false` so a human skimming to the verdict line
  // isn't misled by a green that couldn't evaluate external-edge rules. `isRunComplete` is the one
  // shared predicate for this axis (ADR 023) — see its doc comment (`gates/advisories.ts`).
  console.log(`verdict: ${run.verdict}${isRunComplete(run) ? '' : ' (provisional — dependencies not fully installed)'}`);
}
