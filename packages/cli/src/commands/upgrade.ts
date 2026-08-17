import { InMemoryBaselineStore, type BaselineEntry, type CheckRun, type RepoRelativePath, type ScanBlindSpot } from '@spikedpunch/align-core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, readVersionFile, recordBaselineReconciled } from '../align-dir.js';
import { reportCliError } from '../cli-error.js';
import { refuseIfRunErrored, refuseIfRunIncomplete } from '../errored-run.js';
import { partitionBlindSpotCandidates } from '../scan-blind-spot-retention.js';
import { defaultConfirm } from '../prompt.js';
import { compareVersions } from '../version-skew.js';
import { ALIGN_VERSION } from '../telemetry/process-context.js';
import { allValidatorsForEntry, MIGRATION_REGISTRY, selectRange, type SelectRangeFrom, type Validator, type ValidatorFinding } from '../migrations/index.js';
import { baselineAccept, baselinePrune } from './baseline.js';
import { computeBaselineDebt, persistMovedBaseline } from './check.js';

export interface UpgradeOptions {
  /** `--notes`: print the assembled notes + validator findings for the detected range and exit.
   * Read-only — mutates nothing, stamps nothing (ADR 022). */
  readonly notes?: boolean;
  /** `--from <version>`: override the detected starting version — covers a missing or distrusted
   * `.align/version.json` stamp, and lets a user preview a hop before taking it (ADR 022). */
  readonly from?: string;
  /** `--allow-incomplete` (ADR 023 tier 2): proceed with the prune (deletion) half of
   * reconciliation even though the scan could not resolve all dependencies. */
  readonly allowIncomplete?: boolean;
  /** `-y, --yes`: explicit non-interactive consent to reconcile the baseline (ADR 006's
   * "silence is never consent" doctrine, mirrored from `align init`'s `--accept-existing`). Also
   * usable interactively to skip both prompts below. */
  readonly yes?: boolean;
  /** Test hook, mirroring `InitOptions.nonInteractive` — defaults to `!process.stdin.isTTY`. */
  readonly nonInteractive?: boolean;
  /** Test hook: replaces the real `readline`-backed interactive prompt (`defaultConfirm`) with a
   * scripted answer function, so interactive-mode behavior — including PARTIAL consent (yes to
   * prune, no to accept, or vice versa) — is exercised deterministically without faking a TTY/stdin
   * stream (CODING_BEST_PRACTICES.md §15: inject the I/O boundary rather than reach out to it).
   * Never set by `program.ts`; production always uses the real prompt. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly telemetryPreConfig?: boolean;
}

/** Runs one validator, defensively — validators are contractually read-only and are not supposed
 * to throw (`migrations/types.ts`'s `Validator` doc comment), but an unexpected throw here must
 * not take the whole `upgrade` command down with it. Reports and continues, the same defensive
 * posture `globDoubleStarSelectorDriftValidator` already applies to its OWN config-load/scan
 * failures — this is the layer above: a validator failing in some other, unanticipated way. */
async function runValidator(validator: Validator, rootDir: string): Promise<readonly ValidatorFinding[]> {
  try {
    return await validator.run(rootDir);
  } catch (err) {
    console.error(`align upgrade: validator '${validator.id}' failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function printNotesAndFindings(
  entries: ReturnType<typeof selectRange>['entries'],
  findingsByValidator: readonly { readonly validator: Validator; readonly findings: readonly ValidatorFinding[] }[],
): void {
  for (const entry of entries) {
    for (const note of entry.notes) {
      console.log(`\n[${entry.version}] ${note.heading}`);
      console.log(note.body);
    }
  }
  const withFindings = findingsByValidator.filter((v) => v.findings.length > 0);
  if (withFindings.length === 0) {
    console.log('\nNo validator findings for this range.');
    return;
  }
  for (const { validator, findings } of withFindings) {
    console.log(`\nvalidator '${validator.id}': ${findings.length} finding(s)`);
    for (const finding of findings) {
      console.log(`  - ${finding.summary}`);
      if (finding.affectedFiles !== undefined && finding.affectedFiles.length > 0) {
        for (const file of finding.affectedFiles) console.log(`      ${file}`);
      }
    }
  }
}

/** One consent-gated action's outcome — did anything actually need consenting to, and if so, was
 * the reconciliation for it fully completed? Shared shape for the prune/accept/transform sections
 * below so `fullyReconciled`'s bookkeeping in `runUpgrade` reads the same way for all three. */
interface ActionOutcome {
  readonly actionable: boolean;
  readonly reconciled: boolean;
}

/**
 * `align upgrade` (ADR 022): a consent-gated, guided wrapper over the existing prune → check →
 * accept flow — the exact ceremony `UPGRADING.md` used to describe by hand. Four steps, in order:
 *
 *   1. Read `.align/version.json`; report the transition (or "unknown → current", slice B's
 *      documented decision for a missing stamp).
 *   2. Run every validator registered for the detected range and report findings — always run,
 *      never gated on consent, including under `--notes` (ADR 022's "the tier that earns the most
 *      and risks the least").
 *   3. Run `check` and show the `baselineDebt` delta.
 *   4. Prune orphaned entries and re-accept the churned ones — ONLY after explicit consent.
 *
 * **Consent mirrors `align init`'s interactive-vs-CI split exactly** (`commands/init.ts`, ADR 006):
 * interactive prints a summary and prompts; non-interactive/CI requires the explicit `--yes` flag,
 * because silence is never consent. Unlike `init`'s single yes/no gate, this command asks TWO
 * separate questions when both are relevant — "prune N orphaned entries?" and "re-accept N current
 * violation(s)?" — because ADR 022 names them as two distinct actions ("prune orphaned entries,
 * re-accept the churned ones"), and because that is what makes **partial consent** a real, reachable
 * state (ADR 022 rule 3: accepting one and deferring the other must not advance
 * `baselineReconciledBy`). `--yes` answers both at once, non-interactively or as an interactive
 * shortcut. `--allow-incomplete` (ADR 023 tier 2) can block the prune half entirely, independent of
 * consent — reported the same way a decline is, and equally disqualifying for the stamp.
 *
 * **`baselineReconciledBy` stamping (ADR 022, `recordBaselineReconciled`) obeys all three of its
 * rules here:**
 *   - **Stamped LAST** — only after every actionable item (something with a nonzero count) got
 *     consent AND the corresponding mutation actually completed. This function's crash-safety falls
 *     out of that ordering for free: any failure before the final call leaves `baselineReconciledBy`
 *     exactly as it was, so a re-run of `align upgrade` sees the same unreconciled state and tries
 *     again — "the safe direction is the one where a crash leaves work looking undone."
 *   - **Never on `--notes` or a refusal** — `--notes` returns before any of this; an errored scan
 *     refuses via `refuseIfRunErrored` before the baseline is even read for reconciliation purposes.
 *   - **Never on partial consent** — `fullyReconciled` starts `true` and is set `false` by any
 *     declined or incomplete-blocked actionable item; the stamp is gated on it staying `true`.
 *
 * **Tier 2 (ADR 023) gates deletion only — adds proceed.** A prune blocked by an incomplete scan
 * does not stop the command: it disqualifies the stamp (via `fullyReconciled`) but execution falls
 * through to the accept step regardless, matching "transfers and adds proceed" verbatim.
 */
export async function runUpgrade(rootDir: string, options: UpgradeOptions): Promise<number> {
  let stamp: ReturnType<typeof readVersionFile>;
  try {
    stamp = readVersionFile(rootDir);
  } catch (err) {
    return reportCliError('align upgrade', err);
  }

  const to = ALIGN_VERSION;
  const fromKnown = options.from ?? stamp?.alignVersion;
  const rangeFrom: SelectRangeFrom = fromKnown ?? 'unknown';

  console.log(`align upgrade: ${rangeFrom === 'unknown' ? 'unknown' : rangeFrom} → ${to}`);

  if (rangeFrom !== 'unknown') {
    const cmp = compareVersions(rangeFrom, to);
    if (cmp === 0) {
      console.log('Already at the current version — nothing to reconcile.');
      return 0;
    }
    if (cmp > 0) {
      // `--from` (or a genuinely newer stamp) is NEWER than the running binary: a downgrade.
      // `selectRange` would silently return an empty range here, which reads exactly like
      // "already current" — the false-green shape this command must not produce. `align upgrade`
      // only knows FORWARD migrations; refuse loudly instead of reporting a no-op that looks like
      // success. This is also the more dangerous direction per `version-skew.ts`'s
      // `detectArtifactVersionSkewAdvisory`: `.align/` may carry fingerprints this binary cannot
      // even reproduce, so telling the user nothing needs doing would be actively misleading.
      console.error(
        `align upgrade: refusing — ${rangeFrom} is NEWER than the running align (${to}), so this looks like a ` +
          'downgrade rather than an upgrade. align upgrade only knows forward migrations; there is nothing in the ' +
          `registry to apply. Upgrade align to ${rangeFrom} or later, or pass --from with the version you actually ` +
          'want to migrate from.',
      );
      return 1;
    }
  }

  const selection = selectRange(MIGRATION_REGISTRY, rangeFrom, to);
  const validators = selection.entries.flatMap(allValidatorsForEntry);
  const findingsByValidator: { readonly validator: Validator; readonly findings: readonly ValidatorFinding[] }[] = [];
  for (const validator of validators) {
    findingsByValidator.push({ validator, findings: await runValidator(validator, rootDir) });
  }
  printNotesAndFindings(selection.entries, findingsByValidator);

  if (options.notes === true) return 0; // read-only: mutates nothing, stamps nothing.

  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(rootDir);
  } catch (err) {
    return reportCliError('align upgrade', err);
  }
  const { ruleset, excludes, includeNestedCheckouts, hostRules } = loaded;

  let previousBaseline: BaselineEntry[];
  try {
    previousBaseline = readBaseline(rootDir);
  } catch (err) {
    return reportCliError('align upgrade', err);
  }

  const { orchestrator, baselineStore } = createOrchestrator(ruleset, previousBaseline, hostRules);
  const run: CheckRun = await orchestrator.check({ rootDir, excludes, includeNestedCheckouts });
  try {
    // Same unconditional move-transfer persistence a plain `align check` performs
    // (`commands/check.ts`) — reused rather than re-derived, and deliberately called BEFORE the
    // tier-1 refusal below: ADR 023's "transfer-only" exemption applies here too (a rename must not
    // be lost just because the SAME scan also happened to error on an unrelated gate).
    persistMovedBaseline(rootDir, run, baselineStore);
  } catch (err) {
    return reportCliError('align upgrade', err);
  }

  // Tier 1 (ADR 023): errored scan refuses OUTRIGHT, no override — nothing was evaluated, so there
  // is nothing to report a delta on or consent to. Notes/validators above already printed (they
  // don't depend on this scan), matching the ADR's "still reporting... the notes, the validator
  // findings" language for the tier that DOES permit reporting (tier 2, below).
  const erroredRefusal = refuseIfRunErrored('align upgrade', run, 'refusing to reconcile the baseline');
  if (erroredRefusal !== undefined) return erroredRefusal;

  const baselineDebt = computeBaselineDebt(previousBaseline, run);
  const deltaStr = baselineDebt.delta === 0 ? '0' : `${baselineDebt.delta > 0 ? '+' : ''}${baselineDebt.delta}`;
  console.log(`\nbaselined debt: ${baselineDebt.previous} → ${baselineDebt.current} (${deltaStr})`);

  // Mirrors `init.ts`'s exact interactive-vs-CI ternary, with one addition: an explicit `confirm`
  // override (test-only — see `UpgradeOptions.confirm`'s doc comment) always counts as "we have a
  // way to prompt," independent of `nonInteractive`/stdin — the override IS the interactive channel
  // for a test, in the same way `init.test.ts` can only reach `nonInteractive: true` today because
  // there is no equivalent for forcing the TRUE readline path under a non-TTY test runner.
  const isInteractive =
    options.confirm !== undefined ? true : options.nonInteractive === true ? false : (options.nonInteractive ?? process.stdin.isTTY === true);
  const yes = options.yes === true;
  const confirmFn = options.confirm ?? defaultConfirm;

  // Baseline prune/accept have nothing to do without a baseline — computed as trivial outcomes
  // rather than even scanning again, matching the ORIGINAL early-return's intent for those two
  // tiers specifically. The transform tier is a DIFFERENT concern (ADR 022: config-level drift,
  // independent of whether a baseline has ever been created) and must run regardless — a fresh
  // repo that has never run `baseline accept` can still have a stale `**` selector, and `align
  // upgrade` is exactly where that gets surfaced and offered a fix.
  const hasBaseline = previousBaseline.length > 0;
  let pruneOutcome: ActionOutcome = { actionable: false, reconciled: true };
  let acceptOutcome: ActionOutcome = { actionable: false, reconciled: true };

  if (hasBaseline) {
    // `acceptAtRisk` (below) wants the REAL-baseline run's filtered violations — "currently red,
    // i.e. not yet tolerated" is exactly what `baselineAccept` would additionally accept. The prune
    // preview needs something different: `InMemoryBaselineStore.prune`'s orphan detection
    // (`baseline/store.ts`) decides "is this entry's fingerprint still present ANYWHERE in the
    // current scan" — fed the REAL-baseline run's filtered set, every entry that is STILL correctly
    // tolerated would look orphaned too (its violation is filtered OUT of `run.gates[].violations`
    // precisely because it IS baselined). `baselinePrune`/`baselineAccept` themselves avoid this by
    // scanning with an EMPTY baseline (`commands/baseline.ts`'s `createOrchestrator(ruleset, [],
    // hostRules)`) so nothing is filtered — reused here via a second scan for the same reason, so
    // the preview agrees exactly with what those commands will actually do when invoked.
    const acceptAtRisk = run.gates.flatMap((g) => g.violations).length;
    const { orchestrator: fullOrchestrator } = createOrchestrator(ruleset, [], hostRules);
    const fullRun = await fullOrchestrator.check({ rootDir, excludes, includeNestedCheckouts });
    const allViolations = fullRun.gates.flatMap((g) => g.violations);

    let knownFiles: ReadonlySet<RepoRelativePath>;
    try {
      knownFiles = await orchestrator.knownFiles({ rootDir, excludes, includeNestedCheckouts });
    } catch (err) {
      return reportCliError('align upgrade', err);
    }

    pruneOutcome = await reconcilePrune(
      rootDir,
      run,
      previousBaseline,
      allViolations,
      knownFiles,
      fullRun.blindSpots,
      options,
      isInteractive,
      yes,
      confirmFn,
    );
    acceptOutcome = await reconcileAccept(rootDir, acceptAtRisk, options, isInteractive, yes, confirmFn);
  }

  const transformOutcomes = await reconcileTransforms(rootDir, selection.entries, isInteractive, yes, confirmFn);

  const outcomes = [pruneOutcome, acceptOutcome, ...transformOutcomes];
  const anyActionable = outcomes.some((o) => o.actionable);
  const fullyReconciled = outcomes.every((o) => !o.actionable || o.reconciled);

  if (!hasBaseline && !anyActionable) {
    // Nothing to reconcile at all: no baseline was ever created, and no transform found anything
    // actionable either. Genuinely a no-op — `baselineReconciledBy` is not stamped, because its
    // meaning ("the baseline was brought into agreement with this version") presumes a baseline
    // exists in the first place.
    console.log('No baseline exists — nothing to reconcile.');
    return 0;
  }

  if (!anyActionable) {
    console.log('\nBaseline already agrees with this check — nothing to prune or re-accept.');
  }

  if (fullyReconciled) {
    try {
      recordBaselineReconciled(rootDir);
    } catch (err) {
      return reportCliError('align upgrade', err);
    }
    console.log(`\nReconciled — baseline is now recorded as reconciled under align ${to}.`);
    return 0;
  }

  console.log(
    '\nNot fully reconciled — baselineReconciledBy was NOT advanced. Re-run `align upgrade` to finish once ' +
      'you are ready to consent to the remaining item(s).',
  );
  return 1;
}

function nonConsentMessage(isInteractive: boolean, yes: boolean, verb: string): string {
  if (!isInteractive && !yes) {
    return `\nNot ${verb} — re-run with --yes to reconcile non-interactively (silence is never consent), or run interactively to be prompted.`;
  }
  return `\nNot ${verb}.`;
}

/** Prune half of reconciliation (ADR 022 step 4, ADR 023 tier 2). The at-risk count is computed with
 * a throwaway, in-memory `InMemoryBaselineStore` (never persisted) purely so the consent prompt can
 * name a number; the AUTHORITATIVE mutation and the AUTHORITATIVE tier-2 refusal both happen inside
 * `baselinePrune` itself once consent is granted. The `refuseIfRunIncomplete` call below is a
 * SECOND, independent tier-2 evaluation, deciding only whether to ask at all.
 *
 * Agreement between preview and outcome is not automatic — it holds only because the count below is
 * derived by repeating `baselinePrune`'s own three steps (see the inline comment on each), so the
 * number named in the prompt and fed to this function's tier-2 guard is the same number
 * `baselinePrune` will compute and feed to its own. Review 2026-08-13 found this had drifted: the
 * count was `prune(...).removed.length`, which is `baselinePrune`'s step 1 without steps 2 and 3. */
async function reconcilePrune(
  rootDir: string,
  run: CheckRun,
  previousBaseline: readonly BaselineEntry[],
  allViolations: CheckRun['gates'][number]['violations'],
  knownFiles: ReadonlySet<RepoRelativePath>,
  blindSpots: readonly ScanBlindSpot[],
  options: UpgradeOptions,
  isInteractive: boolean,
  yes: boolean,
  confirmFn: (question: string) => Promise<boolean>,
): Promise<ActionOutcome> {
  const previewStore = new InMemoryBaselineStore(previousBaseline);
  // Step 1, `baselinePrune`'s `store.prune(allViolations, knownFiles, run.blindSpots)`. Passing the
  // blind spots (ADR 027's F1 fix, generalized by ADR 028) keeps an orphan the walk never looked at
  // out of `applyMoves`'s content-fingerprint search, so it lands in `removed` instead of being
  // forged onto a live violation as a "move".
  const previewResult = previewStore.prune(allViolations, knownFiles, blindSpots);
  // Step 2: `PruneResult.removed` carries bare fingerprints, so the entries themselves are recovered
  // from the pre-prune snapshot — `previousBaseline` here, `previous.entries` there.
  const previewByFingerprint = new Map(previousBaseline.map((entry) => [entry.fingerprint, entry]));
  const removedEntries = previewResult.removed
    .map((fingerprint) => previewByFingerprint.get(fingerprint))
    .filter((entry): entry is BaselineEntry => entry !== undefined);
  // Step 3: count only `forfeited`. A `retained` entry is one `baselinePrune` writes straight back
  // (`scan-blind-spot-retention.ts`), so it is never deleted and was never at risk — which is why
  // `baselinePrune` feeds `forfeited.length`, not `removed.length`, to both its report and its own
  // `refuseIfRunIncomplete`. Verified 2026-08-13: counting `removed.length` here instead over-counted
  // by exactly the retained entries, which made the prompt ask consent for a deletion that could not
  // happen ("Prune 1 orphaned baseline entry?" against a prune that forfeits 0 and retains 1) and made
  // the tier-2 guard below refuse on incomplete runs `baselinePrune`'s own tier 2 would have allowed.
  const pruneAtRisk = partitionBlindSpotCandidates(removedEntries, blindSpots).forfeited.length;
  if (pruneAtRisk === 0) return { actionable: false, reconciled: true };

  const incompleteRefusal = refuseIfRunIncomplete('align upgrade', run, pruneAtRisk, options.allowIncomplete ?? false);
  if (incompleteRefusal !== undefined) {
    // Message already printed by `refuseIfRunIncomplete` itself — nothing more to say here. Per
    // ADR 023, this blocks DELETION only; the caller still runs the accept step afterward.
    return { actionable: true, reconciled: false };
  }

  const consented = yes || (isInteractive && (await confirmFn(`\nPrune ${pruneAtRisk} orphaned baseline entr${pruneAtRisk === 1 ? 'y' : 'ies'}?`)));
  if (!consented) {
    console.log(nonConsentMessage(isInteractive, yes, 'pruning'));
    return { actionable: true, reconciled: false };
  }

  const pruneCode = await baselinePrune(rootDir, options.allowIncomplete, options.telemetryPreConfig);
  return { actionable: true, reconciled: pruneCode === 0 }; // a non-zero code already printed its own reason.
}

/** Accept half of reconciliation — "re-accept the churned ones" (ADR 022). Add-only, so ADR 023's
 * tiers don't gate it at all (`errored-run.ts`'s own doc comment: "NOT needed by a command that
 * only ADDS") — the only gate here is consent. `acceptAtRisk` is exactly `allViolations.length`
 * from the SAME real-baseline scan `runUpgrade` already made: those are precisely the violations
 * `baselineAccept`'s own (separately-scanned, empty-baseline) run would also find, since a
 * violation not already in the real baseline is "current" under either scan. */
async function reconcileAccept(
  rootDir: string,
  acceptAtRisk: number,
  options: UpgradeOptions,
  isInteractive: boolean,
  yes: boolean,
  confirmFn: (question: string) => Promise<boolean>,
): Promise<ActionOutcome> {
  if (acceptAtRisk === 0) return { actionable: false, reconciled: true };

  const consented = yes || (isInteractive && (await confirmFn(`\nRe-accept ${acceptAtRisk} current violation(s) into the baseline as reconciled debt?`)));
  if (!consented) {
    console.log(nonConsentMessage(isInteractive, yes, 're-accepting'));
    return { actionable: true, reconciled: false };
  }

  const acceptCode = await baselineAccept(rootDir, undefined, options.telemetryPreConfig);
  return { actionable: true, reconciled: acceptCode === 0 };
}

/** Transform tier (ADR 022). Mirrors `reconcilePrune`/`reconcileAccept`'s actionable/reconciled
 * shape exactly, using `TransformPreview.status` (`migrations/types.ts`) to decide which of three
 * things happens for each transform:
 *
 *  - `'nothing-to-do'` — this transform's precondition wasn't found in this repo. No prompt;
 *    `{ actionable: false, reconciled: true }`, the same "0 at risk" shape `reconcilePrune`/
 *    `reconcileAccept` return when there's nothing for THEM to do either.
 *  - `'refused'` — something was found, but the transform itself is refusing to touch it (an
 *    unverifiable rewrite, an unlocatable/ambiguous config literal, a dirty working tree, ...).
 *    No prompt — there is nothing safe to consent TO — but `{ actionable: true, reconciled: false
 *    }`, so this blocks `baselineReconciledBy` exactly like an ADR-023 `--allow-incomplete`
 *    refusal does. The reason is printed unconditionally (`preview.description`) so the refusal is
 *    visible even though nothing was asked.
 *  - `'ready'` — the ordinary consent-then-`apply` path.
 */
async function reconcileTransforms(
  rootDir: string,
  entries: ReturnType<typeof selectRange>['entries'],
  isInteractive: boolean,
  yes: boolean,
  confirmFn: (question: string) => Promise<boolean>,
): Promise<readonly ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];
  for (const entry of entries) {
    for (const { transform } of entry.transforms) {
      const preview = await transform.preview(rootDir);

      if (preview.status === 'nothing-to-do') {
        outcomes.push({ actionable: false, reconciled: true });
        continue;
      }

      if (preview.status === 'refused') {
        console.log(`\n${preview.description}`);
        outcomes.push({ actionable: true, reconciled: false });
        continue;
      }

      const consented = yes || (isInteractive && (await confirmFn(`\nApply transform '${transform.id}' (${preview.description})?`)));
      if (!consented) {
        console.log(nonConsentMessage(isInteractive, yes, `applying transform '${transform.id}'`));
        outcomes.push({ actionable: true, reconciled: false });
        continue;
      }
      await transform.apply(rootDir);
      outcomes.push({ actionable: true, reconciled: true });
    }
  }
  return outcomes;
}
