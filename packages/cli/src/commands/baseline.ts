import { InMemoryBaselineStore, toRuleId, type BaselineEntry, type RepoRelativePath } from '@spikedpunch/align-core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, writeBaseline } from '../align-dir.js';
import { reportCliError } from '../cli-error.js';
import { refuseIfRunErrored, refuseIfRunIncomplete } from '../errored-run.js';
import { computeRulesetIrHash, createTelemetryRecorder } from '../telemetry/index.js';

/**
 * `readBaseline` throws on a corrupted `.align/baseline.json` (bug hunt 2026-08-03, BUG #1) rather
 * than silently returning `[]` — silently reading it as empty is exactly what let `align baseline
 * accept`'s full-snapshot overwrite (`writeBaseline(rootDir, store.snapshot())`, below) permanently
 * destroy every previously-accepted entry. Every command in this file reads the baseline before it
 * ever writes it, so catching the throw HERE — before `InMemoryBaselineStore` is even constructed —
 * guarantees a corrupt file is reported and left untouched on disk, never overwritten.
 */
function tryReadBaseline(rootDir: string, command: string): { readonly ok: true; readonly entries: BaselineEntry[] } | { readonly ok: false; readonly code: number } {
  try {
    return { ok: true, entries: readBaseline(rootDir) };
  } catch (err) {
    console.error(`${command}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, code: 1 };
  }
}

async function currentViolations(rootDir: string) {
  const { ruleset, excludes, hostRules, telemetry } = await loadConfig(rootDir);
  // An empty baseline store surfaces every violation as "red" regardless of what's actually
  // baselined on disk — exactly the full current violation set `prune`/`accept` need.
  const { orchestrator } = createOrchestrator(ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes });
  return { violations: run.gates.flatMap((g) => g.violations), ruleset, telemetry };
}

export async function baselineAccept(rootDir: string, ruleId?: string, telemetryPreConfig?: boolean): Promise<number> {
  // currentViolations calls loadConfig, which can fail six ways, including a corrupt
  // `.align/generated-rules.json` (bug hunt 2026-08-03, BUG #14) — caught here instead of
  // crashing with a raw Node stack trace.
  let current: Awaited<ReturnType<typeof currentViolations>>;
  try {
    current = await currentViolations(rootDir);
  } catch (err) {
    return reportCliError('align baseline accept', err);
  }
  const { violations, ruleset, telemetry } = current;
  const targeted = ruleId === undefined ? violations : violations.filter((v) => v.ruleId === toRuleId(ruleId));
  const previous = tryReadBaseline(rootDir, 'align baseline accept');
  if (!previous.ok) return previous.code;
  const store = new InMemoryBaselineStore(previous.entries);
  store.accept(targeted, 'manual');
  // `writeBaseline` stamps `alignVersion` (ADR 022's write discipline, `align-dir.ts`) and can
  // throw on a corrupted `.align/version.json` — same corrupt-≠-absent discipline as `tryReadBaseline`
  // above, caught here rather than left as a raw Node stack trace.
  try {
    writeBaseline(rootDir, store.snapshot());
  } catch (err) {
    return reportCliError('align baseline accept', err);
  }
  console.log(`Accepted ${targeted.length} violation(s)${ruleId === undefined ? '' : ` for rule '${ruleId}'`} into the baseline.`);

  const recorder = createTelemetryRecorder(rootDir, 'baseline accept', telemetryPreConfig, telemetry);
  recorder.record(
    {
      kind: 'baseline',
      action: 'accept',
      counts: { accepted: targeted.length },
      ...(ruleId !== undefined ? { ruleScope: ruleId } : {}),
    },
    { rulesetIrHash: computeRulesetIrHash(ruleset) },
  );
  return 0;
}

/**
 * Prune is the only command that DELETES accepted consent decisions, so it is the one place both
 * tiers of ADR 023's completeness invariant are destructive rather than merely wrong:
 *
 *   - **Tier 1 (errored, no override):** an errored gate reports `violations: []`, which made every
 *     baseline entry look orphaned and got it deleted while the command printed "Pruned N fixed
 *     violation(s)" and exited 0 (bug hunt 2026-08-08, BUG #18 — reproduced by shadowing a
 *     component so `align check` reports `verdict: 'error'`). An absent violation on a run that
 *     evaluated nothing means "not verified", never "fixed" — the same lesson `computeBaselineDebt`
 *     (`commands/check.ts`) records for the three reporting sites.
 *   - **Tier 2 (incomplete, overridable via `--allow-incomplete`):** a run that evaluated real rules
 *     but couldn't resolve every external dependency (`complete: false`) drops edges from the
 *     graph, so a violation routed through a dropped edge is unobservable, not fixed — its baseline
 *     entry looks orphaned for a reason unrelated to the code. Reproduces today on `test-apps/n8n`
 *     (verdict red, complete false, 6 orphans).
 *
 * `refuseIfRunErrored`/`refuseIfRunIncomplete` (`errored-run.ts`) are the single guards for this
 * class. Tier 2 is evaluated AFTER `store.prune` (itself pure/in-memory — no I/O) so its refusal
 * can name the precise at-risk count, but BEFORE `writeBaseline` persists anything, so a refusal
 * still leaves the baseline file untouched. A pure move-transfer (nothing actually at risk of
 * deletion) is never refused by tier 2, and even in a refused run that also had moves pending, nothing
 * is lost by deferring them: `align check`'s `persistMovedBaseline` (`commands/check.ts`)
 * independently transfers the same moves, unconditionally, on every run.
 */
export async function baselinePrune(rootDir: string, allowIncomplete?: boolean, telemetryPreConfig?: boolean): Promise<number> {
  // loadConfig can fail six ways, including a corrupt `.align/generated-rules.json` (bug hunt
  // 2026-08-03, BUG #14) — caught here instead of crashing with a raw Node stack trace.
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(rootDir);
  } catch (err) {
    return reportCliError('align baseline prune', err);
  }
  const { ruleset, excludes, hostRules, telemetry } = loaded;
  const previous = tryReadBaseline(rootDir, 'align baseline prune');
  if (!previous.ok) return previous.code;
  const store = new InMemoryBaselineStore(previous.entries);
  const { orchestrator } = createOrchestrator(ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes });
  // Tier 1, BEFORE the store is consulted and before anything is written (see this function's doc
  // comment). No override — an errored scan evaluated no rules at all.
  const refusal = refuseIfRunErrored('align baseline prune', run, 'refusing to prune the baseline');
  if (refusal !== undefined) return refusal;
  const allViolations = run.gates.flatMap((g) => g.violations);
  // `knownFiles` gates move-transfer the same way `align check`'s own reconcileMoves does
  // (FRAGILE #7 fix, bug hunt 2026-08-03) — must be the real current scan's file set, not the
  // empty stub this used to pass (which `store.prune` used to silently ignore anyway).
  let knownFiles: ReadonlySet<RepoRelativePath>;
  try {
    knownFiles = await orchestrator.knownFiles({ rootDir, excludes });
  } catch (err) {
    return reportCliError('align baseline prune', err);
  }
  const result = store.prune(allViolations, knownFiles);
  // Tier 2 — see this function's doc comment for why this runs here (after `store.prune`, before
  // `writeBaseline`) and why deferring on refusal loses nothing.
  const incompleteRefusal = refuseIfRunIncomplete('align baseline prune', run, result.removed.length, allowIncomplete ?? false);
  if (incompleteRefusal !== undefined) return incompleteRefusal;
  // Same corrupt-≠-absent throw risk as `baselineAccept` above (`writeBaseline`'s internal
  // `alignVersion` stamp, ADR 022) — caught here rather than left as a raw Node stack trace.
  try {
    writeBaseline(rootDir, store.snapshot());
  } catch (err) {
    return reportCliError('align baseline prune', err);
  }
  console.log(
    `Pruned ${result.removed.length} fixed violation(s) from the baseline; ` +
      `${result.moved.length} ${result.moved.length === 1 ? 'entry' : 'entries'} transferred (file moves).`,
  );

  const recorder = createTelemetryRecorder(rootDir, 'baseline prune', telemetryPreConfig, telemetry);
  recorder.record(
    { kind: 'baseline', action: 'prune', counts: { removed: result.removed.length, moved: result.moved.length } },
    { rulesetIrHash: computeRulesetIrHash(ruleset) },
  );
  return 0;
}

export async function baselineShow(rootDir: string, ruleId?: string): Promise<number> {
  const previous = tryReadBaseline(rootDir, 'align baseline show');
  if (!previous.ok) return previous.code;
  const store = new InMemoryBaselineStore(previous.entries);
  const entries = store.show(ruleId === undefined ? undefined : { ruleId: toRuleId(ruleId) });
  if (entries.length === 0) {
    console.log('Baseline is empty.');
    return 0;
  }
  for (const entry of entries) {
    console.log(`  ${entry.file}  [${entry.ruleId}]  accepted ${new Date(entry.acceptedAt).toISOString()} (${entry.acceptedBy})`);
  }
  console.log(`\n${entries.length} baselined violation(s).`);
  return 0;
}
