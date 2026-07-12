import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { defineProject, type ComponentsInput } from '@align/core/dsl';
import { TypeScriptPlugin } from '@align/plugin-typescript';
import { detectComponents } from '../init/detect-components.js';
import { suggestLayers } from '../init/suggest-layers.js';
import { renderConfig } from '../init/render-config.js';
import { writeAgentInstructions } from '../init/claude-md.js';
import { writeGeneratedRulesNote } from '../init/config-comment.js';
import { createOrchestrator } from '../composition-root.js';
import { CONFIG_FILENAME, loadConfig } from '../config.js';
import { writeBaseline, ensureAlignDir } from '../align-dir.js';

export interface InitOptions {
  readonly acceptExisting: boolean;
  readonly nonInteractive?: boolean; // test hook; defaults to !process.stdin.isTTY
}

export async function runInit(rootDir: string, options: InitOptions): Promise<number> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  ensureAlignDir(rootDir);

  if (!fs.existsSync(configPath)) {
    const detected = detectComponents(rootDir);
    console.log(`Detected ${detected.length} component(s): ${detected.map((c) => c.name).join(', ')}`);

    // Scan once with components-only (no rules yet) to derive layer suggestions from real edges.
    const componentsInput: ComponentsInput = Object.fromEntries(detected.map((c) => [c.name, c.pattern]));
    const probeRuleset = defineProject({ components: componentsInput });
    const plugin = new TypeScriptPlugin();
    const graph = await plugin.scanner.scan({ rootDir, components: probeRuleset.components, excludes: [] });
    const layers = suggestLayers(graph);

    fs.writeFileSync(configPath, renderConfig(detected, layers), 'utf8');
    console.log(`Wrote ${CONFIG_FILENAME} (cycles-first starter ruleset; ${layers.length} layer suggestion(s) commented out).`);
  } else {
    console.log(`${CONFIG_FILENAME} already exists — leaving it as-is.`);
  }

  writeGeneratedRulesNote(configPath);
  writeAgentInstructions(rootDir);
  console.log('Wrote/updated CLAUDE.md agent-instructions block.');

  const { ruleset, excludes, hostRules } = await loadConfig(rootDir);
  const { orchestrator } = createOrchestrator(ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes });
  const violations = run.gates.flatMap((g) => g.violations);

  if (violations.length === 0) {
    writeBaseline(rootDir, []);
    console.log('Initial check is green — no baseline seeding needed.');
    return 0;
  }

  const isInteractive = options.nonInteractive === true ? false : (options.nonInteractive ?? process.stdin.isTTY === true);

  if (!options.acceptExisting && !isInteractive) {
    console.log(
      `align check found ${violations.length} pre-existing violation(s). Re-run with --accept-existing to seed ` +
        `the baseline non-interactively (silence is never consent — ADR 006), or run interactively to be prompted.`,
    );
    return 1;
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
    return 1;
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
  return 0;
}
