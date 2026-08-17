import { InMemoryBaselineStore, toRuleId, type BaselineEntry, type RepoRelativePath } from '@spikedpunch/align-core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, writeBaseline } from '../align-dir.js';
import { reportCliError } from '../cli-error.js';
import { refuseIfRunErrored, refuseIfRunIncomplete } from '../errored-run.js';
import { describeRetainedEntries, partitionBlindSpotCandidates, retainedEntries } from '../scan-blind-spot-retention.js';
import { createFileExistenceProbe } from '../file-existence.js';
import { describeUnverifiablePrunes, selectUnverifiablePrunes } from '../unverified-prune.js';
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
  const { ruleset, excludes, includeNestedCheckouts, hostRules, telemetry } = await loadConfig(rootDir);
  // An empty baseline store surfaces every violation as "red" regardless of what's actually
  // baselined on disk — exactly the full current violation set `prune`/`accept` need.
  const { orchestrator } = createOrchestrator(rootDir, ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes, includeNestedCheckouts });
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
  // Add-only (CLAUDE.md rule 4's exemption): `accept` never deletes and never transfers, so the
  // probe is never consulted on this path. The real one is passed anyway rather than a stub — a
  // `() => false` here would be a false statement about the working tree that merely happens not to
  // matter today, and the exemption is pinned by a test rather than by this comment.
  const store = new InMemoryBaselineStore(previous.entries, createFileExistenceProbe(rootDir));
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
 *
 * A THIRD hazard, decided separately from ADR 023's two tiers: a scan blind spot (ADR 028 —
 * an auto-excluded nested checkout, an `excludes` match, a `node_modules`-class directory name, an
 * unreadable directory, a symlink) drops files from the scan the same way a missing dependency drops
 * edges, but does NOT set `complete: false` (`isRunComplete` only fires on a `missing-dependencies`
 * advisory), so tier 2 alone does not protect an entry whose file is under one. Unlike tier 2's
 * whole-run taint, this hazard names its own paths precisely (`run.blindSpots`) — so the decided fix
 * is "skip-and-report," not "refuse": every orphan `store.prune` would otherwise delete is
 * partitioned (`scan-blind-spot-retention.ts`) into ones whose file is under a blind spot (RETAINED
 * — re-added to what gets persisted, never deleted) and everything else (forfeited — pruned exactly
 * as before). Tier 2's `refuseIfRunIncomplete` is evaluated against the FORFEITED count only, since
 * a retained entry was never actually at risk once retention put it back.
 *
 * That retention only ever partitioned `result.removed` — it had NO effect on `result.moved` (F1,
 * review 2026-08-12): `store.prune`'s own `applyMoves` step could misclassify an unobserved orphan
 * as "moved" instead of "removed" whenever its `contentFingerprint` collided with a live,
 * never-accepted violation elsewhere — the expected case for a vendored copy of the same code, not
 * an exotic one — silently forging the entry's `acceptedAt`/`acceptedBy` onto that unrelated
 * violation. A "moved" entry never reaches `result.removed`, so the retention partition below never
 * even saw it. Fixed at the source: `store.prune` is now passed `run.blindSpots` so `applyMoves`
 * treats a file under any blind spot as "still known" the same as a file literally present in
 * `knownFiles` — it is routed to `unmatchedOrphans` (this function's `result.removed`) instead of
 * being offered up for a content match, landing it in the exact arm retention already protects.
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
  const { ruleset, excludes, includeNestedCheckouts, hostRules, telemetry } = loaded;
  const previous = tryReadBaseline(rootDir, 'align baseline prune');
  if (!previous.ok) return previous.code;
  const store = new InMemoryBaselineStore(previous.entries, createFileExistenceProbe(rootDir));
  const { orchestrator } = createOrchestrator(rootDir, ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes, includeNestedCheckouts });
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
    knownFiles = await orchestrator.knownFiles({ rootDir, excludes, includeNestedCheckouts });
  } catch (err) {
    return reportCliError('align baseline prune', err);
  }
  // `run.blindSpots` (ADR 027's F1 fix, generalized by ADR 028): without this, `store.prune`'s own
  // move-transfer step (`applyMoves`) could misclassify an orphaned entry whose file the scan simply
  // did not look at as "moved" via a colliding content fingerprint, forging its acceptedAt/acceptedBy
  // onto a genuinely new, never-accepted violation elsewhere — bypassing the retention partition
  // below entirely, since a "moved" entry never reaches `result.removed`. See `store.ts`'s
  // `reconcileMoves`/`applyMoves` doc comments.
  const result = store.prune(allViolations, knownFiles, run.blindSpots);
  // The third hazard (see this function's doc comment): `store.prune` above already deleted every
  // unmatched orphan, INCLUDING ones whose file is unobservable this scan only because the walk
  // never looked there, not because the violation is fixed. `store.prune`'s `PruneResult`
  // only returns fingerprints, so the original entries (with their irreplaceable acceptedAt/By) are
  // recovered from `previous.entries` — the pre-prune snapshot — the only place they still exist.
  const previousByFingerprint = new Map(previous.entries.map((entry) => [entry.fingerprint, entry]));
  const removedEntries = result.removed
    .map((fingerprint) => previousByFingerprint.get(fingerprint))
    .filter((entry): entry is BaselineEntry => entry !== undefined);
  const { retained, forfeited } = partitionBlindSpotCandidates(removedEntries, run.blindSpots, knownFiles, createFileExistenceProbe(rootDir));
  // Tier 2 — see this function's doc comment for why this runs here (after `store.prune`, before
  // `writeBaseline`) and why deferring on refusal loses nothing. Evaluated against FORFEITED only:
  // a retained entry is being put back below, so it was never actually at risk of deletion.
  const incompleteRefusal = refuseIfRunIncomplete('align baseline prune', run, forfeited.length, allowIncomplete ?? false);
  if (incompleteRefusal !== undefined) return incompleteRefusal;
  // Retained entries are re-added to what gets persisted — `store.prune` already deleted them from
  // the store itself, so the store's own snapshot no longer has them; this is the CLI's flat
  // persistence boundary composing the two sets, not a second core API for "undelete".
  const finalEntries = retained.length === 0 ? store.snapshot() : [...store.snapshot(), ...retainedEntries(retained)];
  // Same corrupt-≠-absent throw risk as `baselineAccept` above (`writeBaseline`'s internal
  // `alignVersion` stamp, ADR 022) — caught here rather than left as a raw Node stack trace.
  try {
    writeBaseline(rootDir, finalEntries);
  } catch (err) {
    return reportCliError('align baseline prune', err);
  }
  console.log(
    `Pruned ${forfeited.length} fixed violation(s) from the baseline; ` +
      `${result.moved.length} ${result.moved.length === 1 ? 'entry' : 'entries'} transferred (file moves).`,
  );
  // Not every entry in that "fixed" count was verified to be fixed — see `unverified-prune.ts`.
  // Reported after the headline rather than folded into it: the deletion itself is almost always
  // correct, so this qualifies the claim rather than contradicting it.
  const unverifiable = selectUnverifiablePrunes(forfeited, knownFiles);
  if (unverifiable.length > 0) {
    console.log(describeUnverifiablePrunes(unverifiable));
  }
  if (retained.length > 0) {
    console.log(describeRetainedEntries(retained));
  }

  const recorder = createTelemetryRecorder(rootDir, 'baseline prune', telemetryPreConfig, telemetry);
  recorder.record(
    { kind: 'baseline', action: 'prune', counts: { removed: forfeited.length, moved: result.moved.length } },
    { rulesetIrHash: computeRulesetIrHash(ruleset) },
  );
  return 0;
}

export async function baselineShow(rootDir: string, ruleId?: string): Promise<number> {
  const previous = tryReadBaseline(rootDir, 'align baseline show');
  if (!previous.ok) return previous.code;
  // Read-only: `show` never mutates, so the probe is never consulted here either. Same reasoning as
  // `baselineAccept` above for why it is the real one rather than a stub.
  const store = new InMemoryBaselineStore(previous.entries, createFileExistenceProbe(rootDir));
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
