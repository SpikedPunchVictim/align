import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { ALIGN_VERSION } from '../telemetry/index.js';
import { renderSkillMarkdown } from './render.js';
import { renderVersionStamp } from './version-stamp.js';

const START_MARKER = '<!-- align:start -->';
const END_MARKER = '<!-- align:end -->';

const FRONTMATTER = `---
name: align
description: >-
  Guidance for authoring align architecture-conformance rules (DSL verbs, rule kinds, doc-authoring
  bullet grammar) and for driving the align check-fix-recheck loop until green. Use when the user
  asks to run align, fix an align/align_check violation, author an align.config.ts rule, understand
  an architecture-conformance or dependency-direction failure, or asks what align rule kinds or DSL
  verbs are available. Trigger phrases: "align check", "align violation", "architecture violation",
  "align rule", "fix align", "align.config.ts", "dependency direction", "import cycle", "align skill".
---`;

/**
 * Writes `.claude/skills/align/SKILL.md` into the target repo (Stage 5, IMPLEMENTATION_PLAN.md).
 *
 * Deliberately simpler than `init/claude-md.ts`'s preserve-content-around-the-block discipline:
 * CLAUDE.md is a human-owned file align appends one section to, so re-running `init` must not
 * clobber the surrounding human content. `.claude/skills/align/SKILL.md`, by contrast, is entirely
 * align-generated (nothing else is expected to live in it, the same way nothing hand-written lives
 * in `.align/generated-rules.json`) — every `--install` run fully regenerates it. The
 * `<!-- align:start/end -->` markers are kept anyway for the same visual/debuggability reason
 * every other generated-block file in this repo uses them, and so a future human addition after
 * the block (unlikely, but not impossible) has a documented boundary to sit outside of.
 *
 * Always installs the full (`'all'`) guide regardless of the CLI invocation's `--topic` filter —
 * `--topic` only scopes the stdout preview for a single call; the installed artifact is meant to
 * be complete since it isn't re-run per interaction.
 *
 * The written block is stamped with the installing binary's `ALIGN_VERSION` (`version-stamp.ts`):
 * a human-visible line plus a machine-parseable marker comment, both near the top of the block.
 * Because the whole file is fully regenerated on every `--install` run (see above), re-running
 * naturally updates the stamp in place — there is no separate "patch the existing stamp" step, and
 * no risk of the block or the stamp duplicating.
 */
export function writeSkillFile(rootDir: string, program: Command): string {
  const dir = path.join(rootDir, '.claude', 'skills', 'align');
  const filePath = path.join(dir, 'SKILL.md');
  fs.mkdirSync(dir, { recursive: true });

  const body = renderSkillMarkdown('all', program);
  const content = `${FRONTMATTER}\n\n${START_MARKER}\n${renderVersionStamp(ALIGN_VERSION)}\n\n${body}\n${END_MARKER}\n`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}
