import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defineProject, type ComponentsInput } from '@spikedpunch/align-core/dsl';
import {
  computeContentFingerprint, toComponentName, type BaselineEntry, type CheckRun, type ViolationId } from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { detectComponents } from '../init/detect-components.js';
import { suggestLayers } from '../init/suggest-layers.js';
import { renderConfig } from '../init/render-config.js';
import { assertAgentInstructionsWellFormed, writeAgentInstructions } from '../init/claude-md.js';
import { assertGeneratedRulesNoteWellFormed, writeGeneratedRulesNote } from '../init/config-comment.js';
import { ALIGN_LOCAL_GITIGNORE_ENTRIES, ensureAlignLocalFilesGitignored } from '../init/gitignore.js';
import { offerAlignScript } from '../init/npm-script.js';
import { createOrchestrator } from '../composition-root.js';
import { openScanHistory, type ScanHistory } from '../scan-history.js';
import { CONFIG_FILENAME, loadConfig } from '../config.js';
import { writeBaseline, readBaselineSnapshot, recordBaselineReconciled, type BaselineToken } from '../align-dir.js';
import { reportCliError } from '../cli-error.js';
import { refuseIfRunErrored, refuseIfRunIncomplete } from '../errored-run.js';
import { describeRetainedEntries, partitionBlindSpotCandidates, retainedEntries } from '../scan-blind-spot-retention.js';
import { createFileExistenceProbe } from '../file-existence.js';
import { defaultConfirm } from '../prompt.js';

export interface InitOptions {
  readonly acceptExisting: boolean;
  readonly nonInteractive?: boolean; // test hook; defaults to !process.stdin.isTTY
  /** R4 (greenfield mode, IMPLEMENTATION_PLAN.md Design Reserve): force every detected component
   * to `empty: 'until-populated'` regardless of today's file count — for a repo that's
   * architecture-first from commit zero (components declared, zero files under any of them yet).
   * Without this flag, `runInit` still auto-detects per-component zero-file matches and marks
   * only those — this flag is for the "every component is empty right now" case auto-detection
   * alone already covers, made explicit for a human who wants to say so up front. */
  readonly greenfield?: boolean;
  /** `-y, --yes` (create-align hardening): defaults the npm-script-offer prompt to yes and skips
   * asking, even when interactive. Deliberately does NOT imply `--accept-existing` — baseline
   * seeding is a separate, human consent decision (ADR 006's "silence is never consent" doctrine
   * covers pre-existing violations specifically; a purely-additive npm script does not carry the
   * same risk, so `--yes`/non-interactive alone is enough to default it in). */
  readonly yes?: boolean;
  /** `--no-scripts`: skip the npm-script offer entirely — no prompt, no write. */
  readonly noScripts?: boolean;
  /** `--allow-incomplete` (ADR 023 tier 2, amended 2026-08-11 to cover `align init`): proceed with
   * a baseline write that would drop existing entries even though this scan could not resolve all
   * dependencies (a `missing-dependencies` advisory — `complete: false`). Without it, `init`
   * refuses both the zero-violations reset and the seed-path overwrite rather than silently
   * dropping an entry whose violation merely became unobservable, not fixed. Identical in name and
   * semantics to `align baseline prune`/`align upgrade`'s flag of the same name — see
   * `partitionAndRefuseIfBaselineWriteAtRisk` below for the one guard both of `init`'s write paths
   * share. */
  readonly allowIncomplete?: boolean;
  /** Test hook, mirroring `UpgradeOptions.confirm` (`commands/upgrade.ts`) exactly: replaces the
   * real `readline`-backed interactive seed prompt (`defaultConfirm`, `../prompt.js`) with a
   * scripted answer function, so the interactive consent branch is exercised deterministically
   * without faking a TTY/stdin stream (CODING_BEST_PRACTICES.md §15: inject the I/O boundary
   * rather than reach out to it). Supplying this override IS the statement that there is a way to
   * prompt — it forces `isInteractive` true independent of `nonInteractive`/stdin, the same as
   * `upgrade`'s identical seam does, and for the same reason: a test can only script an ANSWER
   * once the command has already decided to ask. Never set by `program.ts`; production always uses
   * the real prompt. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

/**
 * ADR 023's amendment (2026-08-11): tier 2 extends to `align init`, at BOTH write paths, through
 * ONE guard — the amendment's own "Alternatives considered" rejects guarding each path
 * independently as "precisely how this class reached five copies." This is that one guard.
 *
 * `init` never reads the baseline it overwrites, and `writeBaseline` is a full replace
 * (`align-dir.ts:206`), so on a `complete: false` scan BOTH of `init`'s write paths can silently
 * drop accepted entries whose violation merely became unobservable — dropped external edges hiding
 * a cycle/dependency, not the violation actually being fixed. Reproduced 2026-08-11 against
 * `simple-app-violation-incomplete`, output in the ADR amendment verbatim.
 *
 * At-risk count is one formula for both branches: existing on-disk entries whose fingerprint is
 * absent from the entry set the write is about to persist.
 *   - Zero-violations path (`persistedFingerprints` empty) ⇒ every existing entry is at risk.
 *   - Seed path (`persistedFingerprints` = the current scan's violation ids) ⇒ only the entries the
 *     scan no longer observes are at risk.
 *   - A first `init` with no existing baseline ⇒ `existing` is `[]` ⇒ 0, and `refuseIfRunIncomplete`
 *     already treats `atRiskCount === 0` as "nothing to refuse" — never blocked.
 *
 * Delegates the actual errored-vs-incomplete decision to `refuseIfRunIncomplete` (`errored-run.ts`)
 * rather than re-deciding it here, the same "one shared function, never a copy re-inlined" pattern
 * `stampAlignVersion`/`refuseIfRunErrored` already establish.
 *
 * A SECOND hazard, found auditing this command for the same class (CLAUDE.md rule 6 — "hunt the
 * class, not the instance") that `align baseline prune`'s review fix targets: task #25's
 * nested-checkout auto-exclusion drops edges from the scan the same way a missing dependency does,
 * but does NOT set `complete: false` (`isRunComplete` only fires on `missing-dependencies`), so
 * `refuseIfRunIncomplete` alone does not protect an existing entry whose file lives inside a
 * skipped checkout — both of `init`'s write paths would silently drop it, the exact BUG #18 shape.
 * The decided fix mirrors `baseline prune`'s: "skip-and-report," not "refuse" — every dropped entry
 * is partitioned (`scan-blind-spot-retention.ts`) into RETAINED (file under a scan blind spot —
 * carried into the write unchanged) and forfeited (everything else, dropped exactly as before).
 * `refuseIfRunIncomplete` is evaluated against the forfeited count only, since a retained entry was
 * never actually at risk once retention puts it back into what gets written.
 */
function partitionAndRefuseIfBaselineWriteAtRisk(
  rootDir: string,
  run: CheckRun,
  existing: readonly BaselineEntry[],
  persistedFingerprints: ReadonlySet<ViolationId>,
  allowIncomplete: boolean,
  /** ADR 029 §6's grounding/scope reporting, for the tier-2 refusal's message only — the refusal
   * itself is unchanged (see `refuseIfRunIncomplete`). */
  history: ScanHistory,
): { readonly refusal: number | undefined; readonly retained: ReturnType<typeof partitionBlindSpotCandidates<BaselineEntry>>['retained'] } {
  const dropped = existing.filter((entry) => !persistedFingerprints.has(entry.fingerprint));
  // ADR 028 Stage 2: the probe applies HERE too, not only in `baseline prune`. This path never
  // touches `store.prune`, so a guard living only in the baseline store would have protected
  // `prune` and left both of `init`'s write paths exposed — the same fix-one-arm-miss-the-other
  // shape ADR 027's F1 was.
  // The union of both scan domains, deliberately, and NOT the per-gate split ADR 028 §5 requires
  // for move-transfer. Those answer different questions: §5 forbids judging a `package.json` by the
  // source walker's vocabulary when deciding whether a violation MOVED. Here the question is only
  // "did any part of this scan observe this path", and a file observed by either domain was
  // observed — narrowing it per-domain would call a manifest "unobserved" by the source walker and
  // retain it forever.
  const observedFiles = new Set([...run.observedFiles.source, ...run.observedFiles.manifest]);
  const { retained, forfeited } = partitionBlindSpotCandidates(dropped, run.blindSpots, observedFiles, createFileExistenceProbe(rootDir));
  return { refusal: refuseIfRunIncomplete('align init', run, forfeited.length, allowIncomplete, history), retained };
}

export async function runInit(rootDir: string, options: InitOptions): Promise<number> {
  // `init` is the one command that does NOT resolve a repo root (`program.ts`'s `resolveRootOrFail`
  // — by definition neither marker `align.config.ts` nor `.align/` exists yet on a first run) —
  // it stays cwd-scoped. Printing the target directory up front is the mitigation: a user who
  // meant the repo root but forgot to `cd ..` out of a subdirectory sees it immediately, instead
  // of silently getting `align.config.ts`/`.align/`/`CLAUDE.md` written somewhere unintended.
  console.log(`Initializing align in ${rootDir}`);

  const configPath = path.join(rootDir, CONFIG_FILENAME);

  // No explicit `ensureAlignDir` call here (there used to be one, unconditionally, right at the
  // top) — a run that goes on to REFUSE below (a malformed note-block marker at either
  // `assertGeneratedRulesNoteWellFormed`/`assertAgentInstructionsWellFormed`, or `loadConfig`
  // failing) must leave NO `.align/` behind when there wasn't one already, an undeclared write
  // ADR 026's fail-closed write-set surfaced. Every `.align/` artifact this command actually
  // writes already self-ensures the directory at the point of writing: `writeBaseline`
  // (`align-dir.ts:206-211`) and `recordBaselineReconciled` (`align-dir.ts:164-167`, via
  // `writeVersionFile` at `align-dir.ts:107-110`) both call `ensureAlignDir` themselves. Nothing
  // in between here and those two calls reads or writes anything under `.align/` that requires
  // the directory to pre-exist (`readBaseline` below just does `fs.existsSync` and returns `[]`
  // when absent). So the correct-and-latest placement is: no explicit call at all — the directory
  // comes into being exactly when, and only when, something is actually about to be written into
  // it, on the success path, same as before.
  if (!fs.existsSync(configPath)) {
    const detected = detectComponents(rootDir);
    console.log(`Detected ${detected.length} component(s): ${detected.map((c) => c.name).join(', ')}`);

    // Scan once with components-only (no rules yet) to derive layer suggestions from real edges.
    // `empty: 'allow'` here (not the default 'fail') so the probe scan never crashes on a
    // greenfield repo before we've even had a chance to decide which components need the
    // until-populated marker below — this is a throwaway probe ruleset, never written to disk.
    const componentsInput: ComponentsInput = Object.fromEntries(
      detected.map((c) => [c.name, { pattern: c.pattern, empty: 'allow' as const }]),
    );
    const probeRuleset = defineProject({ components: componentsInput });
    const plugin = new TypeScriptPlugin();
    const graph = await plugin.scanner.scan({ rootDir, components: probeRuleset.components, excludes: [] });
    const layers = suggestLayers(graph);

    // R4: components matching zero files right now (or every component, under --greenfield) get
    // `empty: 'until-populated'` instead of the default fail-on-empty — architecture-first
    // authoring (rules declared before code) works out of the box instead of hitting
    // `ComponentValidationError` on the very first `align check`.
    const populatedNames = new Set(graph.nodes.map((n) => n.component));
    const greenfieldComponents = new Set(
      detected.filter((c) => options.greenfield === true || !populatedNames.has(toComponentName(c.name))).map((c) => c.name),
    );

    fs.writeFileSync(configPath, renderConfig(detected, layers, greenfieldComponents), 'utf8');
    console.log(`Wrote ${CONFIG_FILENAME} (cycles-first starter ruleset; ${layers.length} layer suggestion(s) commented out).`);
    if (greenfieldComponents.size > 0) {
      const reason = options.greenfield === true ? '--greenfield' : 'matched zero files';
      console.log(
        `${greenfieldComponents.size} component(s) (${reason}) set to empty: 'until-populated' ` +
          `(architecture-first authoring: rules load now, enforcement auto-arms once files land): ` +
          `${[...greenfieldComponents].join(', ')}.`,
      );
    }
  } else {
    console.log(`${CONFIG_FILENAME} already exists — leaving it as-is.`);
  }

  // `writeGeneratedRulesNote`/`writeAgentInstructions` throw on a malformed marker state (bug hunt
  // 2026-08-03, BUG #10/#11/#12) — align refuses to guess which content is the human's rather than
  // silently deleting or duplicating it. Both files' marker states are validated up front, before
  // either write, so a malformed CLAUDE.md can't leave align.config.ts silently annotated (or vice
  // versa) on a run that reports overall failure — the two writes below are individually
  // self-atomic (each throws before touching its own file) but validating first makes the *pair*
  // atomic too. Caught here and reported the same way `runInit`'s other refusals are (a printed
  // message plus a non-zero exit), never left to escape as an unhandled rejection out of
  // `program.ts`'s action handler.
  try {
    assertGeneratedRulesNoteWellFormed(configPath);
    assertAgentInstructionsWellFormed(rootDir);
    writeGeneratedRulesNote(configPath);
    writeAgentInstructions(rootDir);
  } catch (err) {
    // Was `console.log` — an inconsistency with every other refusal in this codebase (stderr on
    // failure, stdout on success/progress), normalized to `console.error` here rather than left
    // as a deliberate difference: nothing distinguishes this failure from any other that would
    // justify printing it to stdout, and stdout output survives redirection (`align init >
    // out.log`) in a way that would hide a real failure from the terminal.
    return reportCliError('align init', err);
  }
  console.log('Wrote/updated CLAUDE.md agent-instructions block.');

  if (ensureAlignLocalFilesGitignored(rootDir)) {
    console.log(
      `Wrote/updated .gitignore (excluded align's machine-local files: ${ALIGN_LOCAL_GITIGNORE_ENTRIES.join(', ')}).`,
    );
  }

  // loadConfig can fail six ways, including a corrupt `.align/generated-rules.json` (bug hunt
  // 2026-08-03, BUG #14) — caught here instead of crashing with a raw Node stack trace. By this
  // point CLAUDE.md and align.config.ts's note comment may already have been written above (both
  // purely additive, self-atomic writes independent of loadConfig succeeding), so this refusal
  // still leaves the repo in a valid, re-runnable state rather than rolling anything back.
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(rootDir);
  } catch (err) {
    return reportCliError('align init', err);
  }
  const { ruleset, excludes, includeNestedCheckouts, hostRules } = loaded;

  // ADR 023 amendment (2026-08-11): `init` must read the baseline it is about to overwrite before
  // either write path runs, applying the same corrupt-≠-absent discipline every other baseline
  // consumer already applies (`tryReadBaseline`, `commands/baseline.ts:17-24`) — a corrupt
  // `.align/baseline.json` is reported and refused, never silently replaced with `[]` or a fresh
  // seed. This was the last remaining silent-overwrite path: every other `.align/` artifact reader
  // in this command already fails loudly on corruption (`loadConfig`, above); the baseline itself
  // did not, because until this amendment `init` never read it at all.
  let existingBaseline: BaselineEntry[];
  let baselineToken: BaselineToken;
  try {
    const snapshot = readBaselineSnapshot(rootDir);
    existingBaseline = snapshot.entries;
    baselineToken = snapshot.token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reportCliError('align init', new Error(`${message} Repair or delete the file, then re-run \`align init\`.`));
  }

  // The real probe, even though `init` scans with an EMPTY baseline and so has no orphan for
  // `applyMoves` to transfer: the same reasoning as its `fileExists` argument (`commands/baseline.ts`).
  // A `noScanHistory()` here would be a false statement about the repository that merely happens not
  // to matter today, and the exemption is pinned by a test rather than by this comment. `init` reads
  // the record and never writes it (ADR 029 §7.3).
  // ONE read, two uses: the store's transfer gate and the tier-2 refusal's message (ADR 029 §6). A
  // second `openScanHistory` here would re-read the file and could disagree with the first.
  const history = openScanHistory(rootDir, { ruleset, excludes, includeNestedCheckouts });
  const { orchestrator } = createOrchestrator(rootDir, ruleset, [], hostRules, history.probe);
  const run = await orchestrator.check({ rootDir, excludes, includeNestedCheckouts });
  // `align init` is re-runnable on a repo that already has a baseline ("align.config.ts already
  // exists — leaving it as-is", above), and the zero-violations branch below writes `[]` over it.
  // An errored gate reports `violations: []` without evaluating anything, so that branch used to
  // destroy an existing baseline while printing "Initial check is green" and exiting 0 — the same
  // class as `baselinePrune`'s BUG #18, found in the same sweep. Refuse before any of the baseline
  // branches: the gate's own message tells the user what to fix, and the run is re-runnable after.
  const refusal = refuseIfRunErrored('align init', run, 'refusing to seed or reset the baseline');
  if (refusal !== undefined) return refusal;
  const violations = run.gates.flatMap((g) => g.violations);

  // Mirrors `upgrade.ts`'s exact interactive-vs-CI ternary (`commands/upgrade.ts:224-225`), with the
  // same one addition: an explicit `confirm` override (test-only — see `InitOptions.confirm`'s doc
  // comment) always counts as "we have a way to prompt," independent of `nonInteractive`/stdin — the
  // override IS the interactive channel for a test, in the same way `upgrade`'s tests already use
  // theirs. No existing caller passes `confirm`, so this branch never changes what any of them see.
  const isInteractive =
    options.confirm !== undefined ? true : options.nonInteractive === true ? false : (options.nonInteractive ?? process.stdin.isTTY === true);

  // The npm-script offer runs on every exit path (green, baselined, or declined) — it's an
  // independent, purely-additive convenience, not gated on the baseline outcome.
  const finish = async (code: number): Promise<number> => {
    await offerAlignScript(rootDir, isInteractive, {
      ...(options.noScripts !== undefined ? { noScripts: options.noScripts } : {}),
      ...(options.yes !== undefined ? { yes: options.yes } : {}),
    });
    return code;
  };

  if (violations.length === 0) {
    // ADR 023 amendment: this branch would otherwise persist `[]` — no fingerprint survives — so
    // EVERY existing entry is dropped by default. `partitionAndRefuseIfBaselineWriteAtRisk` runs
    // BEFORE `writeBaseline`/`recordBaselineReconciled` below, so a refusal leaves
    // `.align/baseline.json` untouched; a first `init` with no existing baseline (`existingBaseline`
    // is `[]`) is never refused, since `refuseIfRunIncomplete` treats a zero forfeited count as
    // nothing to refuse. Returned directly, not routed through `finish()` — matching every other
    // refusal in this command. `retained` (see that function's doc comment) is what actually gets
    // persisted below instead of a bare `[]`.
    const atRisk = partitionAndRefuseIfBaselineWriteAtRisk(rootDir, run, existingBaseline, new Set<ViolationId>(), options.allowIncomplete ?? false, history);
    if (atRisk.refusal !== undefined) return atRisk.refusal;

    // `writeBaseline` (a `.align/` artifact writer, `align-dir.ts`) stamps `alignVersion` on its
    // own; `recordBaselineReconciled` is the ADDITIONAL, init/upgrade-only write of
    // `baselineReconciledBy` (ADR 022) — every `init` run re-establishes the baseline from a fresh
    // check, which IS the "deliberate reconciliation" that field records. Both can throw on a
    // corrupted `.align/version.json` (same corrupt-≠-absent discipline as every other artifact
    // reader), caught here the same way every other refusal in this command is.
    try {
      writeBaseline(rootDir, retainedEntries(atRisk.retained), baselineToken);
      recordBaselineReconciled(rootDir);
    } catch (err) {
      return reportCliError('align init', err);
    }
    console.log('Initial check is green — no baseline seeding needed.');
    if (atRisk.retained.length > 0) console.log(describeRetainedEntries(atRisk.retained));
    return finish(0);
  }

  if (!options.acceptExisting && !isInteractive) {
    console.log(
      `align check found ${violations.length} pre-existing violation(s). Re-run with --accept-existing to seed ` +
        `the baseline non-interactively (silence is never consent — ADR 006), or run interactively to be prompted.`,
    );
    return finish(1);
  }

  // ADR 023 amendment: this branch persists only the fingerprints the CURRENT scan observed, so an
  // existing entry the scan no longer sees (dropped edge, not a genuine fix, on `complete: false`)
  // would otherwise be silently dropped — the "not previously identified" half of the amendment's
  // reproduction. Same guard as the zero-violations branch above, and BEFORE the consent prompt
  // below for the reason `align upgrade`'s `reconcilePrune` (`commands/upgrade.ts:309-335`) states
  // for its own identical ordering: the guard decides whether to even ask, "so the prompt and the
  // outcome cannot disagree with each other." Asking "seed the baseline?" and then refusing the
  // `yes` would be exactly that disagreement. Runs before `writeBaseline`/`recordBaselineReconciled`
  // either way, so a refusal leaves `.align/baseline.json` untouched.
  const seedAtRisk = partitionAndRefuseIfBaselineWriteAtRisk(
    rootDir,
    run,
    existingBaseline,
    new Set(violations.map((v) => v.id)),
    options.allowIncomplete ?? false,
    history,
  );
  if (seedAtRisk.refusal !== undefined) return seedAtRisk.refusal;

  let shouldSeed = options.acceptExisting;
  if (!shouldSeed && isInteractive) {
    console.log(`\nalign check found ${violations.length} pre-existing violation(s) — this is normal on a repo align hasn't seen before.`);
    console.log('Seeding the baseline tolerates them as existing debt; run `align baseline show` any time to review what was seeded.');
    // `defaultConfirm` (`../prompt.js`) appends its own `[y/N] ` suffix — the question string below
    // must NOT append one itself, or the prompt would read `[y/N] [y/N] `.
    shouldSeed = await (options.confirm ?? defaultConfirm)('Seed the baseline with these violations now?');
  }

  if (!shouldSeed) {
    console.log('Not seeding the baseline. `align check` will report red until you fix these or run `align baseline accept`.');
    return finish(1);
  }

  // ADR 023 amendment, "Resolved (same day): the seed path preserves provenance" (2026-08-11): a
  // re-run of `init` used to rewrite EVERY surviving entry's `acceptedAt`/`acceptedBy` to
  // `init-seed`/`accept-existing` at now, even on a complete scan where nothing else was lost —
  // erasing the audit trail of a consent decision ADR 006 treats as the human's (a `manual` accept
  // came back stamped `accept-existing` on every subsequent `init`). The fix is a merge, not a
  // replace: a violation the scan observed that ALSO has an existing baseline entry with the same
  // fingerprint inherits that entry's `acceptedAt`/`acceptedBy` verbatim; only a genuinely new
  // violation (no prior entry with that fingerprint) is freshly stamped, exactly as before.
  //
  // `ruleId` and `file` are deliberately never taken from `prior` — only the provenance pair is.
  // Fingerprints are content-snippet hashes, not line numbers or paths (ADR 006), so a violation
  // whose file MOVED keeps its fingerprint; carrying the prior entry's `file` over verbatim would
  // persist a stale path, which is the exact drift `store.reconcileMoves` exists to prevent
  // elsewhere. Always read `ruleId`/`file` off `v` (the current scan), never off `prior`.
  //
  // `contentFingerprint` and `acceptedValue` ARE carried from `prior`, and the omission of that
  // was a defect (repro: integration/scenarios/init-rerun-preserves-content-fingerprint.mjs, plus
  // the two-arm unit test in core/test/baseline.test.ts). This rebuild is a whole-entry
  // reconstruction, so every field it does not explicitly carry is silently DROPPED. Dropping
  // these two is not cosmetic: `applyMoves` matches orphans on `contentFingerprint`, so an entry
  // that lost it can never be rescued when its file is renamed — it becomes an unmatched orphan
  // and the next `align baseline prune` DELETES it while reporting it as fixed, exit 0. Losing
  // `acceptedValue` silently disables FRAGILE #8's `arch.metric` growth advisory for that entry.
  //
  // Both are spread conditionally rather than assigned, because `BaselineEntry` declares them
  // optional for back-compat (`baseline/schema.ts`: files written before the fields existed must
  // still parse) and writing an explicit `undefined` would serialize a null-ish key into every
  // entry of every baseline align touches.
  //
  // NOT computed from `v` for entries that have no prior. `init`-seeded entries have never carried
  // `contentFingerprint` in any release, so backfilling one here would newly make them eligible
  // for move-transfer — a behavior change to the rescue path (the mechanism F1 was about), not a
  // fix to this drop. It may well be the right follow-up; it needs its own justification and its
  // own test, and it is deliberately not smuggled in here.
  //
  // This is a merge of PROVENANCE, not a union of ENTRIES: an existing entry with no matching
  // fingerprint in `violations` still isn't in this map at all and is dropped, same as before —
  // that half stays governed by `partitionAndRefuseIfBaselineWriteAtRisk` above, which already
  // refused this write if dropping any of it would be unsafe on an incomplete scan, and which
  // supplies `seedAtRisk.retained` below — entries dropped from `violations` only because their
  // file is inside a skipped nested checkout, carried into the write unchanged rather than lost.
  const existingByFingerprint = new Map(existingBaseline.map((entry) => [entry.fingerprint, entry]));

  try {
    writeBaseline(
      rootDir,
      [
        ...violations.map((v) => {
          const prior = existingByFingerprint.get(v.id);
          return {
            fingerprint: v.id,
            ruleId: v.ruleId,
            file: v.file,
            acceptedAt: prior?.acceptedAt ?? Date.now(),
            acceptedBy: prior?.acceptedBy ?? (options.acceptExisting ? ('accept-existing' as const) : ('init-seed' as const)),
            // DERIVED from the violation, not carried from `prior` (LEDGER D035, bug hunt B3). This
            // read `prior?.contentFingerprint` and dropped the field entirely whenever the structural
            // fingerprint had changed — which is exactly what a RENAME does, since `fingerprint` folds
            // in file identity (`store.ts`: "a rename produces a brand-new fingerprint and orphans the
            // old baseline entry by construction"). The entry was then re-seeded with no
            // `contentFingerprint`, and an entry without one can never participate in a move-transfer
            // again, so the NEXT rename made it an unmatchable orphan and `align baseline prune`
            // deleted it reporting "Pruned 1 fixed violation(s)" at exit 0 — while `align check` was
            // red on the violation it had just called fixed.
            //
            // Deriving is both simpler and safer than matching: it is what `store.accept` already does
            // for every entry it creates, it needs no guess about which prior entry a moved violation
            // came from, and it cannot carry one violation's consent onto another. What it does NOT
            // recover is `acceptedAt`/`acceptedBy` across a rename — those still reset, and that is
            // reported below rather than fixed by guessing.
            contentFingerprint: computeContentFingerprint(v.ruleId, v.snippet),
            ...(prior?.acceptedValue === undefined ? {} : { acceptedValue: prior.acceptedValue }),
          };
        }),
        ...retainedEntries(seedAtRisk.retained),
      ],
      baselineToken,
    );
    recordBaselineReconciled(rootDir);
  } catch (err) {
    return reportCliError('align init', err);
  }
  console.log(`Seeded baseline with ${violations.length} pre-existing violation(s) — run \`align baseline show\` to review.`);
  if (seedAtRisk.retained.length > 0) console.log(describeRetainedEntries(seedAtRisk.retained));
  return finish(0);
}
