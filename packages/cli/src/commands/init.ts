import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { defineProject, type ComponentsInput } from '@spikedpunch/align-core/dsl';
import { toComponentName } from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { detectComponents } from '../init/detect-components.js';
import { suggestLayers } from '../init/suggest-layers.js';
import { renderConfig } from '../init/render-config.js';
import { writeAgentInstructions } from '../init/claude-md.js';
import { writeGeneratedRulesNote } from '../init/config-comment.js';
import { ensureTelemetryGitignored } from '../init/gitignore.js';
import { offerAlignScript } from '../init/npm-script.js';
import { createOrchestrator } from '../composition-root.js';
import { CONFIG_FILENAME, loadConfig } from '../config.js';
import { writeBaseline, ensureAlignDir } from '../align-dir.js';

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

  writeGeneratedRulesNote(configPath);
  writeAgentInstructions(rootDir);
  console.log('Wrote/updated CLAUDE.md agent-instructions block.');

  if (ensureTelemetryGitignored(rootDir)) {
    console.log('Wrote/updated .gitignore (excluded .align/telemetry.jsonl + .align/telemetry-state.json — opt-in, local-only).');
  }

  const { ruleset, excludes, hostRules } = await loadConfig(rootDir);
  const { orchestrator } = createOrchestrator(ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes });
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
    writeBaseline(rootDir, []);
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
  console.log(`Seeded baseline with ${violations.length} pre-existing violation(s) — run \`align baseline show\` to review.`);
  return finish(0);
}
