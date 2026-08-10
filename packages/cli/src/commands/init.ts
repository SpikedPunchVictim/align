import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { defineProject, type ComponentsInput } from '@spikedpunch/align-core/dsl';
import { toComponentName } from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { detectComponents } from '../init/detect-components.js';
import { suggestLayers } from '../init/suggest-layers.js';
import { renderConfig } from '../init/render-config.js';
import { assertAgentInstructionsWellFormed, writeAgentInstructions } from '../init/claude-md.js';
import { assertGeneratedRulesNoteWellFormed, writeGeneratedRulesNote } from '../init/config-comment.js';
import { ensureTelemetryGitignored } from '../init/gitignore.js';
import { offerAlignScript } from '../init/npm-script.js';
import { createOrchestrator } from '../composition-root.js';
import { CONFIG_FILENAME, loadConfig } from '../config.js';
import { writeBaseline, ensureAlignDir, recordBaselineReconciled } from '../align-dir.js';
import { reportCliError } from '../cli-error.js';
import { refuseIfRunErrored } from '../errored-run.js';

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
}

export async function runInit(rootDir: string, options: InitOptions): Promise<number> {
  // `init` is the one command that does NOT resolve a repo root (`program.ts`'s `resolveRootOrFail`
  // — by definition neither marker `align.config.ts` nor `.align/` exists yet on a first run) —
  // it stays cwd-scoped. Printing the target directory up front is the mitigation: a user who
  // meant the repo root but forgot to `cd ..` out of a subdirectory sees it immediately, instead
  // of silently getting `align.config.ts`/`.align/`/`CLAUDE.md` written somewhere unintended.
  console.log(`Initializing align in ${rootDir}`);

  const configPath = path.join(rootDir, CONFIG_FILENAME);
  ensureAlignDir(rootDir);

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

  if (ensureTelemetryGitignored(rootDir)) {
    console.log('Wrote/updated .gitignore (excluded .align/telemetry.jsonl + .align/telemetry-state.json — opt-in, local-only).');
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
  const { ruleset, excludes, hostRules } = loaded;
  const { orchestrator } = createOrchestrator(ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes });
  // `align init` is re-runnable on a repo that already has a baseline ("align.config.ts already
  // exists — leaving it as-is", above), and the zero-violations branch below writes `[]` over it.
  // An errored gate reports `violations: []` without evaluating anything, so that branch used to
  // destroy an existing baseline while printing "Initial check is green" and exiting 0 — the same
  // class as `baselinePrune`'s BUG #18, found in the same sweep. Refuse before any of the baseline
  // branches: the gate's own message tells the user what to fix, and the run is re-runnable after.
  const refusal = refuseIfRunErrored('align init', run, 'refusing to seed or reset the baseline');
  if (refusal !== undefined) return refusal;
  const violations = run.gates.flatMap((g) => g.violations);

  const isInteractive = options.nonInteractive === true ? false : (options.nonInteractive ?? process.stdin.isTTY === true);

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
    // `writeBaseline` (a `.align/` artifact writer, `align-dir.ts`) stamps `alignVersion` on its
    // own; `recordBaselineReconciled` is the ADDITIONAL, init/upgrade-only write of
    // `baselineReconciledBy` (ADR 022) — every `init` run re-establishes the baseline from a fresh
    // check, which IS the "deliberate reconciliation" that field records. Both can throw on a
    // corrupted `.align/version.json` (same corrupt-≠-absent discipline as every other artifact
    // reader), caught here the same way every other refusal in this command is.
    try {
      writeBaseline(rootDir, []);
      recordBaselineReconciled(rootDir);
    } catch (err) {
      return reportCliError('align init', err);
    }
    console.log('Initial check is green — no baseline seeding needed.');
    return finish(0);
  }

  if (!options.acceptExisting && !isInteractive) {
    console.log(
      `align check found ${violations.length} pre-existing violation(s). Re-run with --accept-existing to seed ` +
        `the baseline non-interactively (silence is never consent — ADR 006), or run interactively to be prompted.`,
    );
    return finish(1);
  }

  let shouldSeed = options.acceptExisting;
  if (!shouldSeed && isInteractive) {
    console.log(`\nalign check found ${violations.length} pre-existing violation(s) — this is normal on a repo align hasn't seen before.`);
    console.log('Seeding the baseline tolerates them as existing debt; run `align baseline show` any time to review what was seeded.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Seed the baseline with these violations now? [y/N] ');
    rl.close();
    shouldSeed = /^y(es)?$/i.test(answer.trim());
  }

  if (!shouldSeed) {
    console.log('Not seeding the baseline. `align check` will report red until you fix these or run `align baseline accept`.');
    return finish(1);
  }

  try {
    writeBaseline(
      rootDir,
      violations.map((v) => ({
        fingerprint: v.id,
        ruleId: v.ruleId,
        file: v.file,
        acceptedAt: Date.now(),
        acceptedBy: options.acceptExisting ? ('accept-existing' as const) : ('init-seed' as const),
      })),
    );
    recordBaselineReconciled(rootDir);
  } catch (err) {
    return reportCliError('align init', err);
  }
  console.log(`Seeded baseline with ${violations.length} pre-existing violation(s) — run \`align baseline show\` to review.`);
  return finish(0);
}
