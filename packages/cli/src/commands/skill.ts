import type { Command } from 'commander';
import { renderSkillMarkdown, type SkillTopic } from '../skill/render.js';
import { writeSkillFile } from '../skill/install.js';

export type { SkillTopic };

export interface SkillOptions {
  readonly topic: SkillTopic;
  readonly install: boolean;
}

/**
 * `align skill` (Stage 5, IMPLEMENTATION_PLAN.md "Elevated first items"): emits the LLM-facing
 * authoring/fixing guide, generated live from the installed binary's own registries so it cannot
 * drift from what this specific install actually supports. `--install` additionally writes
 * `.claude/skills/align/SKILL.md` into the target repo (cwd).
 *
 * `program` is the already-built `commander` tree the CLI command inventory section reads
 * (`../program.js`'s `buildProgram()`'s own `program` closure variable, passed in by its `skill`
 * action rather than re-imported here — see `skill/cli-inventory.ts`'s doc comment for why a
 * static import back to `program.ts` would be a dependency cycle).
 */
export async function runSkill(rootDir: string, options: SkillOptions, program: Command): Promise<number> {
  const markdown = renderSkillMarkdown(options.topic, program);
  process.stdout.write(`${markdown}\n`);

  if (options.install) {
    const filePath = writeSkillFile(rootDir, program);
    console.error(`Wrote ${filePath}`);
  }

  return 0;
}
