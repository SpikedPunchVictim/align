import * as fs from 'node:fs';
import * as path from 'node:path';

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
 * duplicates or corrupts human-authored instructions around the block.
 */
export function writeAgentInstructions(rootDir: string, filename = 'CLAUDE.md'): void {
  const filePath = path.join(rootDir, filename);
  const newBlock = block();

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${newBlock}\n`, 'utf8');
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    fs.writeFileSync(filePath, `${before}${newBlock}${after}`, 'utf8');
    return;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, `${existing}${separator}${newBlock}\n`, 'utf8');
}
