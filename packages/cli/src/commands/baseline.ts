import {
  InMemoryBaselineStore,
  describeMovedEntries,
  noScanHistory,
  toRuleId,
  type BaselineEntry,
  type RepoRelativePath,
} from '@spikedpunch/align-core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaselineSnapshot, writeBaseline, type BaselineToken } from '../align-dir.js';
import { reportCliError } from '../cli-error.js';
import { refuseIfRunErrored, refuseIfRunIncomplete } from '../errored-run.js';
import { describeRetainedEntries, partitionBlindSpotCandidates, retainedEntries } from '../scan-blind-spot-retention.js';
import { parseForgetUnscannedPrefix, splitForgotten } from '../forget-unscanned.js';
import { describeForgetPrefixMatchedNothing, describeForgottenEntries, describePruneOutcome } from '../prune-report.js';
import { createFileExistenceProbe } from '../file-existence.js';
import { openScanHistory } from '../scan-history.js';
import { describeUnverifiablePrunes, selectUnverifiablePrunes } from '../unverified-prune.js';
import { computeRulesetIrHash, createTelemetryRecorder } from '../telemetry/index.js';
import { defaultConfirm } from '../prompt.js';

/**
 * `readBaseline` throws on a corrupted `.align/baseline.json` (bug hunt 2026-08-03, BUG #1) rather
 * than silently returning `[]` — silently reading it as empty is exactly what let `align baseline
 * accept`'s full-snapshot overwrite (`writeBaseline(rootDir, store.snapshot())`, below) permanently
 * destroy every previously-accepted entry. Every command in this file reads the baseline before it
 * ever writes it, so catching the throw HERE — before `InMemoryBaselineStore` is even constructed —
 * guarantees a corrupt file is reported and left untouched on disk, never overwritten.
 */
function tryReadBaseline(
  rootDir: string,
  command: string,
): { readonly ok: true; readonly entries: BaselineEntry[]; readonly token: BaselineToken } | { readonly ok: false; readonly code: number } {
  try {
    // Snapshot, not a bare read: whatever this returns will be written back after a scan, and the
    // token is what proves nobody else wrote in between (`writeBaseline`).
    return { ok: true, ...readBaselineSnapshot(rootDir) };
  } catch (err) {
    console.error(`${command}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, code: 1 };
  }
}

async function currentViolations(rootDir: string) {
  const { ruleset, excludes, includeNestedCheckouts, hostRules, telemetry } = await loadConfig(rootDir);
  // An empty baseline store surfaces every violation as "red" regardless of what's actually
  // baselined on disk — exactly the full current violation set `prune`/`accept` need.
  const { orchestrator } = createOrchestrator(
    rootDir,
    ruleset,
    [],
    hostRules,
    openScanHistory(rootDir, { ruleset, excludes, includeNestedCheckouts }).probe,
  );
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
  // Add-only (CLAUDE.md rule 4's exemption): `accept` never deletes and never transfers, so neither
  // probe is consulted on this path. The real `fileExists` is passed anyway rather than a stub — a
  // `() => false` here would be a false statement about the working tree that merely happens not to
  // matter today, and the exemption is pinned by a test rather than by this comment.
  //
  // `noScanHistory()` and NOT the real record, which is the one place these two arguments diverge:
  // building the real probe needs the scan scope (ADR 029 §4's `scopeIdentity`), and `collectCurrent`
  // does not hand `excludes` back. Widening its return type to satisfy an argument `applyMoves` can
  // never reach on this path would be shape S-06 — machinery whose only justification is symmetry.
  // The claim being made is narrow and checkable: this store never transfers. Pinned by a test.
  const store = new InMemoryBaselineStore(previous.entries, createFileExistenceProbe(rootDir), noScanHistory());
  store.accept(targeted, 'manual');
  // `writeBaseline` stamps `alignVersion` (ADR 022's write discipline, `align-dir.ts`) and can
  // throw on a corrupted `.align/version.json` — same corrupt-≠-absent discipline as `tryReadBaseline`
  // above, caught here rather than left as a raw Node stack trace.
  try {
    writeBaseline(rootDir, store.snapshot(), previous.token);
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
 * An OPTIONS OBJECT rather than positional parameters, changed in ADR 028 Stage 4 when the third
 * one arrived. `baselinePrune(dir, true, false)` was already hard to read at a call site; adding a
 * path as a fourth positional beside two booleans is the shape that produces a silently-transposed
 * argument in the one command in this codebase that deletes accepted consent decisions.
 */
export interface PruneOptions {
  /** ADR 023 tier 2's override. */
  readonly allowIncomplete?: boolean;
  /** `-y, --yes`: consent to the deletion without being asked (ADR 006 — "silence is never
   * consent"). Every removal `prune` performs destroys an accepted consent decision, so the
   * command asks before it deletes and refuses when it cannot ask. Decided 2026-08-17: retention
   * alone made the safe direction cost friction on the commonest debt-paydown path (deleting dead
   * code), and an approval gate pays for that friction with a single keystroke instead of a second
   * command. */
  readonly yes?: boolean;
  /** Test hook, mirroring `InitOptions`/`UpgradeOptions` exactly: supplying it IS the statement
   * that there is a way to prompt, so it forces the interactive branch independent of stdin. */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Test hook; defaults to `!process.stdin.isTTY`, same as `init`. */
  readonly nonInteractive?: boolean;
  /** `--forget-unscanned <prefix>`: forfeit the retained entries at or under this repo-relative
   * prefix (ADR 028 Stage 4). Validated by `parseForgetUnscannedPrefix` before anything else runs;
   * absent means retention behaves exactly as it did in Stage 2. */
  readonly forgetUnscanned?: string;
  readonly telemetryPreConfig?: boolean;
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
 *
 * ADR 028 Stage 4 closes the two ends that "skip-and-report" leaves open, and they pull in opposite
 * directions:
 *
 *   - **MECHANISM 3, the missing-directory test** (`scan-blind-spot-retention.ts`). Mechanisms 1
 *     and 2 both answer "nothing explains this absence" for a file whose whole directory is gone,
 *     so a partial checkout emptied the baseline at exit 0 — reproduced 2026-08-17 by both
 *     reviewers. An entry whose directory produced no observed file at all is retained instead.
 *     This REPLACED a whole-run refusal (a "floor") that was tried first and removed the same day:
 *     it was a per-run guard against per-entry damage, so it missed the partial checkout it was
 *     written for, and its non-overridable refusal trapped legitimate repositories with no way out.
 *   - **A WAY BACK OUT** (`--forget-unscanned <prefix>`, `forget-unscanned.ts`). Retention with no
 *     forfeiture path is a one-way ratchet: entries under a permanently-excluded subtree could never
 *     be removed by any command. The flag is scoped to an explicit prefix, applied to the retained
 *     half only, and its entries count as at-risk for tier 2 — a forgotten entry is as deleted as a
 *     forfeited one, and the ONLY difference is that align never claimed to have verified it.
 */
export async function baselinePrune(rootDir: string, options: PruneOptions = {}): Promise<number> {
  const { allowIncomplete, forgetUnscanned, telemetryPreConfig } = options;
  // Flag validation FIRST, before the scan and before the baseline is even read: a malformed
  // `--forget-unscanned` value is a mistake in the invocation, not a fact about the repository, and
  // spending a full scan before reporting it would just delay the message. `reportCliError` prints
  // it with the command name attached, like every other refusal in this file.
  let forgetPrefix: RepoRelativePath | undefined;
  if (forgetUnscanned !== undefined) {
    const parsed = parseForgetUnscannedPrefix(forgetUnscanned);
    if (!parsed.ok) return reportCliError('align baseline prune', new Error(parsed.message));
    forgetPrefix = parsed.prefix;
  }
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
  // ONE history for both: the store's `applyMoves` consults it (ADR 029 §6) and so does the run that
  // produces the violations fed to it, so a second read here could disagree with the first if another
  // align wrote in between. `prune` reads the record and never writes it — deletion is not a transfer
  // decision, and ADR 029 §7.3 keeps the writer set to the surfaces that persist one.
  const history = openScanHistory(rootDir, { ruleset, excludes, includeNestedCheckouts });
  const store = new InMemoryBaselineStore(previous.entries, createFileExistenceProbe(rootDir), history.probe);
  const { orchestrator } = createOrchestrator(rootDir, ruleset, [], hostRules, history.probe);
  const run = await orchestrator.check({ rootDir, excludes, includeNestedCheckouts });
  // Tier 1, BEFORE the store is consulted and before anything is written (see this function's doc
  // comment). No override — an errored scan evaluated no rules at all.
  const refusal = refuseIfRunErrored('align baseline prune', run, 'refusing to prune the baseline');
  if (refusal !== undefined) return refusal;
  const allViolations = run.gates.flatMap((g) => g.violations);
  // `knownFiles` gates move-transfer the same way `align check`'s own reconcileMoves does
  // (FRAGILE #7 fix, bug hunt 2026-08-03) — the real current scan's file set.
  //
  // ADR 028 Stage 3: taken off THE RUN ABOVE, not from a second walk. This used to call
  // `orchestrator.knownFiles(...)`, which re-scanned both domains from scratch — so `prune` decided
  // what to delete using a file set that no rule evaluation had ever seen, and the two walks were
  // assumed to agree. They usually did; when they could not (a file deleted between them) the
  // disagreement was invisible and pointed the wrong way. One walk, one set of facts.
  //
  // UNIONED, deliberately, and this is the one place the two domains are combined. `store.prune`
  // takes a single `knownFiles` and `applyMoves` iterates EVERY baseline entry regardless of which
  // gate produced it, so a per-domain split would make every manifest entry look unobserved during
  // the source pass and vice versa — mass over-retention, or worse. The union is what the deleted
  // `knownFiles()` computed too; the difference is that it is now visible, derived from this run,
  // and costs no extra I/O. `CheckRun` still carries the domains apart (ADR 028 §5) precisely so
  // this consumer can make the merge explicitly rather than inherit it from a helper.
  const knownFiles: ReadonlySet<RepoRelativePath> = new Set([
    ...run.observedFiles.source,
    ...run.observedFiles.manifest,
  ]);
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
  const partition = partitionBlindSpotCandidates(removedEntries, run.blindSpots, knownFiles, createFileExistenceProbe(rootDir));
  const forfeited = partition.forfeited;
  // ADR 028 Stage 4's escape hatch. Applied to the RETAINED half only (`forget-unscanned.ts` says
  // why), and after the partition rather than before it, so the flag can only ever undo retention —
  // it cannot change what "fixed" means for an entry retention never touched.
  const forgetSplit = forgetPrefix === undefined ? undefined : splitForgotten(partition.retained, forgetPrefix);
  const forgotten = forgetSplit?.forgotten ?? [];
  const retained = forgetSplit?.retained ?? partition.retained;
  // Tier 2 — see this function's doc comment for why this runs here (after `store.prune`, before
  // `writeBaseline`) and why deferring on refusal loses nothing. Evaluated against the entries that
  // will actually be DELETED: the forfeited ones, plus any the user forfeited explicitly with
  // `--forget-unscanned`. A retained entry is being put back below, so it was never at risk; a
  // forgotten one is as permanently gone as a forfeited one, and tier 2's whole subject is deletion.
  const incompleteRefusal = refuseIfRunIncomplete('align baseline prune', run, forfeited.length + forgotten.length, allowIncomplete ?? false);
  if (incompleteRefusal !== undefined) return incompleteRefusal;
  // ADR 006's consent gate, added 2026-08-17. EVERY deletion below destroys an accepted consent
  // decision, and this command is the only one whose PURPOSE is that deletion — which is exactly
  // why it asked for nothing until now. Two things changed the calculus: retention (ADR 028) made
  // `prune` safe-but-frictional on the commonest debt-paydown path (a developer deletes dead code,
  // and mechanism 3 correctly cannot tell that from a partial checkout), and a gate converts that
  // friction from "run a second command" into "press y". The gate is on the DELETION, not on the
  // command: a run that forfeits nothing (a pure move-transfer, a no-op, or an all-retained run)
  // is never blocked. State that precisely rather than as a reassurance: an unattended `prune` that
  // finds nothing to delete still succeeds, and one that finds something now FAILS instead of
  // deleting it. A pre-commit hook or CI step that prunes must pass `--yes` to keep working — that
  // is a breaking change, and it is documented in UPGRADING.md rather than left for a red build to
  // explain. (An earlier version of this comment claimed prune "stays a safe thing to put in a
  // pre-commit hook", which is false for the only case that matters — LEDGER D013.)
  //
  // Non-interactive without `--yes` REFUSES rather than proceeding: this is ADR 006's doctrine
  // verbatim, and the same shape `init`'s seed path and `upgrade`'s reconciliation already use.
  const deletionCount = forfeited.length + forgotten.length;
  const isInteractive =
    options.confirm !== undefined ? true : options.nonInteractive === true ? false : (options.nonInteractive ?? process.stdin.isTTY === true);
  const confirmFn = options.confirm ?? defaultConfirm;
  if (deletionCount > 0 && options.yes !== true) {
    if (!isInteractive) {
      return reportCliError(
        'align baseline prune',
        new Error(
          `refusing to delete ${deletionCount} accepted consent ${deletionCount === 1 ? 'decision' : 'decisions'} ` +
            'without consent — this is not an interactive terminal, and silence is never consent (ADR 006). ' +
            'Re-run with --yes if you have reviewed what is being removed.',
        ),
      );
    }
    const consented = await confirmFn(
      `\nDelete ${deletionCount} accepted consent ${deletionCount === 1 ? 'decision' : 'decisions'} from the baseline?`,
    );
    if (!consented) {
      console.log('Not pruning — the baseline is unchanged.');
      return 1;
    }
  }
  // Retained entries are re-added to what gets persisted — `store.prune` already deleted them from
  // the store itself, so the store's own snapshot no longer has them; this is the CLI's flat
  // persistence boundary composing the two sets, not a second core API for "undelete".
  const finalEntries = retained.length === 0 ? store.snapshot() : [...store.snapshot(), ...retainedEntries(retained)];
  // Same corrupt-≠-absent throw risk as `baselineAccept` above (`writeBaseline`'s internal
  // `alignVersion` stamp, ADR 022) — caught here rather than left as a raw Node stack trace.
  try {
    writeBaseline(rootDir, finalEntries, previous.token);
  } catch (err) {
    return reportCliError('align baseline prune', err);
  }
  console.log(describePruneOutcome(forfeited.length, retained.length, result.moved.length, forgotten.length));
  // The transfers `prune` performed, named rather than counted — same report `align check` prints,
  // for the same reason: a transfer carries a human's acceptance onto a different file and align
  // cannot prove the violation moved (LEDGER D015). The headline above still carries the count, so
  // this adds detail without replacing the summary.
  if (result.moved.length > 0) {
    console.log(describeMovedEntries(result.moved));
  }
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
  if (forgetPrefix !== undefined) {
    console.log(forgotten.length > 0 ? describeForgottenEntries(forgotten, forgetPrefix) : describeForgetPrefixMatchedNothing(forgetPrefix));
  }

  const recorder = createTelemetryRecorder(rootDir, 'baseline prune', telemetryPreConfig, telemetry);
  recorder.record(
    {
      kind: 'baseline',
      action: 'prune',
      // `removed` stays the count align CONCLUDED was fixed; `forgotten` is counted separately
      // because it is a user instruction, not an inference — collapsing them would make the two
      // indistinguishable in telemetry exactly where the difference matters.
      counts: { removed: forfeited.length, moved: result.moved.length, ...(forgotten.length > 0 ? { forgotten: forgotten.length } : {}) },
    },
    { rulesetIrHash: computeRulesetIrHash(ruleset) },
  );
  return 0;
}

export async function baselineShow(rootDir: string, ruleId?: string): Promise<number> {
  const previous = tryReadBaseline(rootDir, 'align baseline show');
  if (!previous.ok) return previous.code;
  // Read-only: `show` never mutates, so neither probe is consulted here either. Same reasoning as
  // `baselineAccept` above — the real `fileExists`, and `noScanHistory()` because there is no scan
  // scope in hand and nothing on this path could ask it a question.
  const store = new InMemoryBaselineStore(previous.entries, createFileExistenceProbe(rootDir), noScanHistory());
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
