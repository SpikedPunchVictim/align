/**
 * Carried Stage 3 affordance (approved by the user ahead of Stage 4): `align build --apply` and
 * `align init` write/refresh a short comment in `align.config.ts` noting that
 * `.align/generated-rules.json` is auto-merged when present — visibility for the implicit merge
 * `loadConfig` already performs (`mergeGeneratedRules`, `config.ts`). Idempotent, delimited,
 * same 3-branch pattern as the CLAUDE.md agent-instructions block (`claude-md.ts`) — but using
 * `//`-line comments since `align.config.ts` is TypeScript, not markdown (`<!-- -->` doesn't
 * parse there).
 */
import * as fs from 'node:fs';

const START_MARKER = '// align:generated-rules-note:start';
const END_MARKER = '// align:generated-rules-note:end';

function block(): string {
  return [
    START_MARKER,
    '// `.align/generated-rules.json` (written by `align build --apply`, ADR 011) is merged into',
    '// this ruleset automatically at load time (`mergeGeneratedRules`) — you never need to import',
    '// it here. Run `align explain <ruleId>` to see a rule\'s provenance (hand-authored vs.',
    '// doc-built).',
    END_MARKER,
  ].join('\n');
}

/**
 * Idempotent, comment-delimited write: re-running never duplicates or corrupts the rest of
 * `align.config.ts`. Splices the block back in between existing markers if found; otherwise
 * appends it. Never touches file content it doesn't own.
 */
export function writeGeneratedRulesNote(configPath: string): void {
  if (!fs.existsSync(configPath)) return; // nothing to annotate yet — `runInit` writes this first

  const existing = fs.readFileSync(configPath, 'utf8');
  const newBlock = block();

  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    fs.writeFileSync(configPath, `${before}${newBlock}${after}`, 'utf8');
    return;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(configPath, `${existing}${separator}${newBlock}\n`, 'utf8');
}
