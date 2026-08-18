import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeImpactDelta,
  diffGeneratedRules,
  evaluateRule,
  groundFragment,
  InMemoryBaselineStore,
  mergeGeneratedRules,
  proposeRulesFromDoc,
  sha256Hex,
  toRepoRelativePath,
  toRuleId,
  type BuildProposal,
  type ComponentDefinitionIR,
  type ComponentName,
  type FlaggedProposal,
  type GeneratedRulesFile,
  type HostPredicateRegistry,
  type ImpactDelta,
  type RepoRelativePath,
  type RuleDiff,
  type RuleFragment,
  type RuleIR,
  type RulesLock,
  type SourceRange,
} from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { loadConfig, CONFIG_FILENAME } from '../config.js';
import { assertGeneratedRulesNoteWellFormed, writeGeneratedRulesNote } from '../init/config-comment.js';
import { printDryRunReport, renderBuildReport } from './build-report.js';
import { reportCliError } from '../cli-error.js';
import { createFileExistenceProbe } from '../file-existence.js';
import { defaultConfirm } from '../prompt.js';
import {
  readBaseline,
  readBaselineSnapshot,
  readGeneratedRules,
  readRulesLock,
  writeBaseline,
  writeGeneratedRules,
  writeLastBuildReport,
  writeRulesLock,
} from '../align-dir.js';
import { computeRulesetIrHash, createTelemetryRecorder } from '../telemetry/index.js';
// The lockfile-verification cluster (reproducible hashing, divergence detection, `--verify`) lives
// in its own sibling module — a coherent seam separate from this file's command orchestration
// (`runBuild`) and artifact-writing (`writeBuildArtifacts`). Re-exported below so existing callers
// (`commands/check.ts`, tests) keep importing from `commands/build.js` unchanged.
import { reproducibleGeneratedRulesHash, verifyFrozenRules } from './build-verify.js';

export { reproducibleGeneratedRulesHash, verifyFrozenRules, type VerifyResult } from './build-verify.js';

export const DEFAULT_DOC_PATH = 'docs/ARCHITECTURE-RULES.md';

export interface BuildOptions {
  readonly doc?: string;
  readonly apply: boolean;
  readonly ifChanged: boolean;
  readonly verify: boolean;
  readonly acceptNewIntoBaseline: boolean;
  readonly nonInteractive?: boolean; // test hook; defaults to !process.stdin.isTTY, same as `init`
  /** Test hook, mirroring `InitOptions.confirm`/`UpgradeOptions.confirm` exactly: replaces the real
   * `readline`-backed interactive prompt (`defaultConfirm`, `../prompt.js`) that asks whether to
   * seed newly-added violations into the baseline, with a scripted answer function, so the
   * interactive consent branch is exercised deterministically without faking a TTY/stdin stream
   * (CODING_BEST_PRACTICES.md §15: inject the I/O boundary rather than reach out to it). Supplying
   * the override IS the statement that there is a way to prompt — it forces `isInteractive` true
   * independent of `nonInteractive`/stdin, same as `init`'s and `upgrade`'s identical seams. Never
   * set by `program.ts`; production always uses the real prompt. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly telemetryPreConfig?: boolean;
}

/** `build` telemetry (IMPLEMENTATION_PLAN.md's telemetry spec): recorded once per successful
 * `dryRunBuild`/`proposeFromClientSubmission` — dry-run and `--apply` both compute the same
 * `DryRunResult`, so one call covers both; `--verify` and an `--if-changed` no-op never reach a
 * `DryRunResult` at all and so never emit (nothing was actually built/diffed to report). */
async function recordBuildTelemetry(rootDir: string, docRelPath: string, result: DryRunResult, telemetryPreConfig?: boolean): Promise<void> {
  const { ruleset, telemetry } = await loadConfig(rootDir);
  const recorder = createTelemetryRecorder(rootDir, 'build', telemetryPreConfig, telemetry);
  if (!recorder.enabled) return;
  recorder.record(
    {
      kind: 'build',
      doc: docRelPath,
      structuralChanges: result.diff.added.length + result.diff.changed.length + result.diff.removed.length,
      provenanceOnlyChanges: result.diff.provenanceOnlyChanged.length,
      impactDelta: { newViolations: result.impact.addedNew.length, maskedBaselined: result.impact.maskedBaselined.length },
    },
    { rulesetIrHash: computeRulesetIrHash(ruleset) },
  );
}

export interface DryRunResult {
  readonly docRelPath: string;
  readonly docPath: RepoRelativePath;
  readonly docContentHash: string;
  readonly proposal: BuildProposal;
  readonly diff: RuleDiff;
  readonly impact: ImpactDelta;
}

/**
 * The shared back half of the build pipeline (ADR 011): given a fully-formed `BuildProposal` —
 * either derived from parsing the doc (`dryRunBuild`) or assembled from an MCP client's submitted
 * proposals (`proposeFromClientSubmission`) — diffs it against what's currently written and
 * compiles both the current and proposed effective rulesets in memory to compute the impact delta.
 * One scan, two `evaluateRule` passes (pure) — avoids a second filesystem rescan just to compare
 * two rulesets against the same code. Writes nothing.
 */
async function computeBuildResult(
  rootDir: string,
  docRelPath: string,
  docContentHash: string,
  proposal: BuildProposal,
  baseRuleset: { readonly rules: readonly RuleIR[]; readonly components: Readonly<Record<ComponentName, ComponentDefinitionIR>> },
  excludes: readonly string[],
  includeNestedCheckouts: readonly string[],
  hostRules: HostPredicateRegistry,
): Promise<DryRunResult> {
  const existingGenerated = readGeneratedRules(rootDir)?.rules ?? [];
  const diff = diffGeneratedRules(existingGenerated, proposal.rules);

  const currentEffectiveRules = mergeGeneratedRules(baseRuleset.rules, existingGenerated);
  const proposedEffectiveRules = mergeGeneratedRules(baseRuleset.rules, proposal.rules);

  const plugin = new TypeScriptPlugin();
  const graph = await plugin.scanner.scan({ rootDir, components: baseRuleset.components, excludes, includeNestedCheckouts });
  const currentViolations = currentEffectiveRules.flatMap((r) => evaluateRule(r, graph, baseRuleset.components, hostRules));
  const proposedViolations = proposedEffectiveRules.flatMap((r) => evaluateRule(r, graph, baseRuleset.components, hostRules));

  const impact = computeImpactDelta(currentViolations, proposedViolations, readBaseline(rootDir));

  return { docRelPath, docPath: toRepoRelativePath(docRelPath), docContentHash, proposal, diff, impact };
}

/**
 * The deterministic dry-run pipeline (ADR 011): parse the doc -> propose rules (precision ladder,
 * tiers 1+2, zero LLM) -> `computeBuildResult`. Shared by the CLI (`runBuild`) and, indirectly, the
 * MCP `align_propose_rules` tool's pass-1 discovery response (which surfaces the same
 * deterministic rules for the client to pass through in pass 2).
 */
export async function dryRunBuild(rootDir: string, docRelPath: string): Promise<DryRunResult> {
  const absDocPath = path.join(rootDir, docRelPath);
  if (!fs.existsSync(absDocPath)) {
    throw new Error(`Doc not found: ${docRelPath}`);
  }
  const docText = fs.readFileSync(absDocPath, 'utf8');
  const docPath = toRepoRelativePath(docRelPath);
  const docContentHash = sha256Hex(docText);

  const { ruleset: baseRuleset, excludes, includeNestedCheckouts, hostRules } = await loadConfig(rootDir, { includeGenerated: false });
  const proposal = proposeRulesFromDoc(docText, docPath, baseRuleset.components, new Set(hostRules.keys()));

  return computeBuildResult(rootDir, docRelPath, docContentHash, proposal, baseRuleset, excludes, includeNestedCheckouts, hostRules);
}

export interface ClientSubmission {
  readonly fragment: RuleFragment;
  /** The section anchor this proposal belongs to (echoed back from pass 1's section list) —
   * used only for the audit report / lockfile attribution, never for grounding (grounding is
   * selector-based, `ground.ts`). */
  readonly section: string;
  readonly sourceLineRange: SourceRange;
  readonly sourceQuote: string;
}

/**
 * Assembles a `BuildProposal` from an MCP client's submitted proposals (ADR 011 two-pass
 * clarification, pass 2/apply): re-parses the doc for its deterministic tier-1/2 rules (cheap,
 * idempotent — gives the correct section list/hashes for the lockfile) and merges in the client's
 * submissions, each grounded exactly the same way a doc-parsed fragment is (`ground.ts`) — align
 * validates and grounds; the client agent supplies the judgment (no API key in align, ADR 011).
 */
export async function proposeFromClientSubmission(
  rootDir: string,
  docRelPath: string,
  submissions: readonly ClientSubmission[],
): Promise<DryRunResult> {
  const absDocPath = path.join(rootDir, docRelPath);
  if (!fs.existsSync(absDocPath)) {
    throw new Error(`Doc not found: ${docRelPath}`);
  }
  const docText = fs.readFileSync(absDocPath, 'utf8');
  const docPath = toRepoRelativePath(docRelPath);
  const docContentHash = sha256Hex(docText);

  const { ruleset: baseRuleset, excludes, includeNestedCheckouts, hostRules } = await loadConfig(rootDir, { includeGenerated: false });
  const registeredHostPredicates = new Set(hostRules.keys());
  const base = proposeRulesFromDoc(docText, docPath, baseRuleset.components, registeredHostPredicates);

  const flagged: FlaggedProposal[] = [...base.flagged];
  const ruleIdsBySection = new Map<string, string[]>(base.sections.map((s) => [s.anchor, [...s.ruleIds]]));
  const byId = new Map<string, RuleIR>(base.rules.map((r) => [r.id, r]));

  for (const sub of submissions) {
    const result = groundFragment(
      sub.fragment,
      sub.section,
      docPath,
      sub.sourceLineRange,
      sub.sourceQuote,
      baseRuleset.components,
      registeredHostPredicates,
    );
    if (!result.ok) {
      flagged.push(result.flagged);
      continue;
    }
    byId.set(result.rule.id, result.rule); // client submission wins on id collision with a tier-1/2 rule
    const list = ruleIdsBySection.get(sub.section);
    if (list === undefined) ruleIdsBySection.set(sub.section, [result.rule.id]);
    else list.push(result.rule.id);
  }

  const proposal: BuildProposal = {
    sections: base.sections.map((s) => ({
      ...s,
      ruleIds: [...new Set(ruleIdsBySection.get(s.anchor) ?? [])].map((id) => toRuleId(id)),
    })),
    rules: [...byId.values()],
    flagged,
    proseSections: base.proseSections,
  };

  return computeBuildResult(rootDir, docRelPath, docContentHash, proposal, baseRuleset, excludes, includeNestedCheckouts, hostRules);
}

export interface ApplyResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Writes `.align/generated-rules.json`, `.align/rules.lock.json`, and
 * `.align/last-build-report.md` (ADR 011) — the same function backs both `align build --apply`
 * and the MCP `align_propose_rules` `{ apply: true }` call. New violations require explicit
 * consent (`acceptNewIntoBaseline`) mirroring `align init`'s baseline-seed consent doctrine
 * (ADR 006) — refuses to write otherwise.
 */
export function writeBuildArtifacts(
  rootDir: string,
  result: DryRunResult,
  options: { readonly acceptNewIntoBaseline: boolean },
): ApplyResult {
  if (result.impact.addedNew.length > 0 && !options.acceptNewIntoBaseline) {
    return {
      ok: false,
      message:
        `The proposed ruleset adds ${result.impact.addedNew.length} new violation(s). Re-run with ` +
        `--accept-new-into-baseline to seed them as tolerated debt (silence is never consent, ADR 006), ` +
        `or address them in the doc/code first.`,
    };
  }

  // This function writes three artifacts in sequence — `.align/generated-rules.json`,
  // `align.config.ts`'s note comment (`writeGeneratedRulesNote`), then `.align/rules.lock.json`
  // (and optionally the baseline) — and `loadConfig` silently merges generated-rules.json into the
  // effective ruleset on every load (`config.ts:128-141`) regardless of whether the lockfile or
  // baseline write ever happened. `writeGeneratedRulesNote` throws on a malformed marker state
  // (bug hunt 2026-08-03, BUG #10/#11/#12) — validated HERE, before any of the three writes, so a
  // malformed align.config.ts fails this whole sequence atomically. Catching the throw only around
  // the note write (the first fix attempt) left a window where generated-rules.json was already on
  // disk — silently in force at the next `align check` — while `writeBuildArtifacts` reported
  // failure and never wrote the matching lockfile or (with `--accept-new-into-baseline`) baseline
  // entries.
  try {
    assertGeneratedRulesNoteWellFormed(path.join(rootDir, CONFIG_FILENAME));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  // Only groundable rules are ever written — `proposal.rules` already excludes everything in
  // `proposal.flagged` (ADR 011: ungroundable -> flagged, never silently written).
  const generatedFile: GeneratedRulesFile = {
    irVersion: '1',
    docPath: result.docRelPath,
    generatedAt: Date.now(),
    rules: [...result.proposal.rules],
  };
  writeGeneratedRules(rootDir, generatedFile);
  const generatedRulesContentHash = reproducibleGeneratedRulesHash(generatedFile);
  writeGeneratedRulesNote(path.join(rootDir, CONFIG_FILENAME));

  if (options.acceptNewIntoBaseline && result.impact.addedNew.length > 0) {
    // Add-only (CLAUDE.md rule 4's exemption): this path only ever calls `accept` + `snapshot`, so
    // the probe is never consulted. Passed for real anyway — see `commands/baseline.ts`'s
    // `baselineAccept` for why a stub would be a false statement rather than a harmless one.
    const baseline = readBaselineSnapshot(rootDir);
    const store = new InMemoryBaselineStore(baseline.entries, createFileExistenceProbe(rootDir));
    store.accept(result.impact.addedNew, 'manual');
    writeBaseline(rootDir, store.snapshot(), baseline.token);
  }

  const lock: RulesLock = {
    irVersion: '1',
    docPath: result.docRelPath,
    docContentHash: result.docContentHash,
    builtAt: Date.now(),
    sections: result.proposal.sections.map((s) => ({
      anchor: s.anchor,
      headingText: s.headingText,
      startLine: s.startLine,
      endLine: s.endLine,
      contentHash: s.contentHash,
      tier: s.tier,
      ruleIds: [...s.ruleIds],
    })),
    generatedRulesContentHash,
  };
  writeRulesLock(rootDir, lock);
  writeLastBuildReport(rootDir, renderBuildReport(result));

  const flaggedNote = result.proposal.flagged.length > 0 ? ` ${result.proposal.flagged.length} flagged (not written) — see the report.` : '';
  const baselineNote =
    options.acceptNewIntoBaseline && result.impact.addedNew.length > 0
      ? ` Seeded ${result.impact.addedNew.length} new violation(s) into the baseline.`
      : '';

  return {
    ok: true,
    message:
      `Wrote .align/generated-rules.json (${result.proposal.rules.length} rule(s)), .align/rules.lock.json, ` +
      `and .align/last-build-report.md. Diff: ${result.diff.added.length} added, ${result.diff.changed.length} changed, ` +
      `${result.diff.removed.length} removed, ${result.diff.unchanged.length} unchanged${provenanceOnlyNote(result.diff)}.` +
      `${flaggedNote}${baselineNote}`,
  };
}

/** Provenance-only changes (a `.because()`/source-quote edit with no structural difference) are
 * reported separately from `unchanged`/`changed` — see `build/diff.ts`'s `RuleDiff.
 * provenanceOnlyChanged` doc comment for the live-session bug this fixes (agent-attached rationale
 * text made 10 byte-identical rules show up as "changed"). Renders nothing when there are none, so
 * the common case (no provenance churn) doesn't add noise to every build's output. */
function provenanceOnlyNote(diff: RuleDiff): string {
  if (diff.provenanceOnlyChanged.length === 0) return '';
  return `, ${diff.provenanceOnlyChanged.length} unchanged (provenance-only updates)`;
}

/** CLI entrypoint (`align build`). */
export async function runBuild(rootDir: string, options: BuildOptions): Promise<number> {
  const docRelPath = options.doc ?? DEFAULT_DOC_PATH;

  if (options.verify) {
    const lock = readRulesLock(rootDir);
    if (lock === undefined) {
      console.log('No .align/rules.lock.json — run `align build --apply` first.');
      return 1;
    }
    const result = verifyFrozenRules(rootDir);
    if (result.ok) {
      console.log('align build --verify: OK — doc and generated-rules.json match the lockfile.');
      return 0;
    }
    for (const a of result.advisories) console.log(`  ${a.kind}: ${a.message}`);
    return 1;
  }

  const absDocPath = path.join(rootDir, docRelPath);
  if (!fs.existsSync(absDocPath)) {
    console.error(`Doc not found: ${docRelPath}`);
    return 1;
  }

  if (options.ifChanged) {
    const lock = readRulesLock(rootDir);
    if (lock !== undefined) {
      const docContentHash = sha256Hex(fs.readFileSync(absDocPath, 'utf8'));
      if (docContentHash === lock.docContentHash) {
        console.log(`${docRelPath}: unchanged since the last build — nothing to do.`);
        return 0;
      }
    }
  }

  // R3 (greenfield mode): `dryRunBuild` scans the same path `align check` does, so a
  // zero-`empty:'fail'`-component throws the same `ComponentValidationError` — caught here the
  // same way `orchestrator.ts` catches it, instead of a raw Node stack trace
  // (GREENFIELD_TRIAD_REPORT.md §3). `'until-populated'`/`'allow'` components never throw at all.
  // `computeBuildResult` (inside `dryRunBuild`) also reads `.align/baseline.json` via
  // `readBaseline`, which throws on a corrupted file (bug hunt 2026-08-03, BUG #1) — reported the
  // same clean way rather than left to become an unattributed Node stack trace.
  let result: DryRunResult;
  try {
    result = await dryRunBuild(rootDir, docRelPath);
  } catch (err) {
    // A `ComponentValidationError` (`err.message`) and any other thrown `Error` both format
    // identically through `reportCliError` (`err instanceof Error ? err.message : String(err)`),
    // so the special case this used to carry was vestigial — collapsed to one call.
    return reportCliError('align build', err);
  }
  printDryRunReport(result);
  await recordBuildTelemetry(rootDir, docRelPath, result, options.telemetryPreConfig);

  if (!options.apply) {
    console.log('\nDry run only — nothing written. Re-run with --apply to write generated-rules.json.');
    return 0;
  }

  let acceptNewIntoBaseline = options.acceptNewIntoBaseline;
  if (result.impact.addedNew.length > 0 && !acceptNewIntoBaseline) {
    // Mirrors `init.ts`'s/`upgrade.ts`'s exact interactive-vs-CI ternary: an explicit `confirm`
    // override (test-only — see `BuildOptions.confirm`'s doc comment) always counts as "we have a
    // way to prompt," independent of `nonInteractive`/stdin. No existing caller passes `confirm`,
    // so this never changes what any of them see.
    const isInteractive =
      options.confirm !== undefined ? true : options.nonInteractive === true ? false : (options.nonInteractive ?? process.stdin.isTTY === true);
    if (isInteractive) {
      console.log(`\nThe proposed ruleset adds ${result.impact.addedNew.length} new violation(s).`);
      // `defaultConfirm` (`../prompt.js`) appends its own `[y/N] ` suffix — the question string
      // below must NOT append one itself, or the prompt would read `[y/N] [y/N] `.
      acceptNewIntoBaseline = await (options.confirm ?? defaultConfirm)('Seed these into the baseline as tolerated debt and apply?');
    }
  }

  // `writeBuildArtifacts` reads `.align/baseline.json` via `readBaseline` when seeding new
  // violations (`acceptNewIntoBaseline`), which throws on a corrupted file (bug hunt 2026-08-03,
  // BUG #1) rather than the `{ ok: false, message }` shape it uses for its own recoverable
  // refusals — caught here the same way, not left as a raw Node stack trace.
  let applied: ApplyResult;
  try {
    applied = writeBuildArtifacts(rootDir, result, { acceptNewIntoBaseline });
  } catch (err) {
    return reportCliError('align build', err);
  }
  console.log(`\n${applied.message}`);
  return applied.ok ? 0 : 1;
}
