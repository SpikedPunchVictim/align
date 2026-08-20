import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertBlockWellFormed, spliceOrAppendBlock } from './marker-block.js';
import { writeFileAtomic } from '../fs-atomic.js';

const START_MARKER = '<!-- align:start -->';
const END_MARKER = '<!-- align:end -->';

const BLOCK_BODY = `## align — architecture conformance

This repo is checked by [align](https://github.com/SpikedPunchVictim/align) for dependency-direction and import-cycle
conformance. Run \`align check\` (or the \`align_check\` MCP tool if the align MCP server is
connected) after any structural code change — new imports, moved files, restructured modules.

**A red \`align check\` is blocking.** Do not consider a structural change complete while
\`align check\` reports red. Run \`align explain <ruleId>\` (or the \`align_explain_rule\` MCP tool)
to understand why a rule fired before proposing a fix.

For full rule-authoring guidance run \`align skill --topic authoring\`.`;

function block(): string {
  return `${START_MARKER}\n${BLOCK_BODY}\n${END_MARKER}`;
}

/**
 * Idempotent, HTML-comment-delimited write (ADR 009 consequence): re-running `align init` never
 * duplicates or corrupts human-authored instructions around the block. Throws — via
 * `spliceOrAppendBlock` — when the file has a malformed marker arrangement (an orphan START or
 * END, END before START, or more than one pair); callers must catch and report this rather than
 * let it escape as an unhandled rejection (bug hunt 2026-08-03, BUG #10/#11/#12).
 */
export function writeAgentInstructions(rootDir: string, filename = 'CLAUDE.md'): void {
  const filePath = path.join(rootDir, filename);
  const newBlock = block();

  if (!fs.existsSync(filePath)) {
    writeFileAtomic(filePath, `${newBlock}\n`);
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const next = spliceOrAppendBlock(existing, newBlock, filePath, START_MARKER, END_MARKER);
  writeFileAtomic(filePath, next);
}

/**
 * Pre-flight check for `writeAgentInstructions`: throws if `filePath` exists and its block is
 * malformed, without writing anything. `runInit` (`commands/init.ts`) calls this — alongside
 * `config-comment.ts`'s `assertGeneratedRulesNoteWellFormed` — before writing either file, so a
 * malformed marker state in one file can't leave the other silently modified while the run reports
 * failure.
 */
export function assertAgentInstructionsWellFormed(rootDir: string, filename = 'CLAUDE.md'): void {
  const filePath = path.join(rootDir, filename);
  if (!fs.existsSync(filePath)) return;
  assertBlockWellFormed(fs.readFileSync(filePath, 'utf8'), filePath, START_MARKER, END_MARKER);
}
