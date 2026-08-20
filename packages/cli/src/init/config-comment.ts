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
import { assertBlockWellFormed, spliceOrAppendBlock } from './marker-block.js';
import { writeFileAtomic } from '../fs-atomic.js';

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
 * appends it. Never touches file content it doesn't own. Throws — via `spliceOrAppendBlock` —
 * when the file has a malformed marker arrangement (an orphan START or END, END before START, or
 * more than one pair); callers must catch and report this rather than let it escape as an
 * unhandled rejection. This is the higher-consequence sibling of `claude-md.ts`'s write: a
 * malformed state here used to be able to splice away the user's entire hand-authored ruleset
 * (bug hunt 2026-08-03, BUG #10/#11/#12).
 */
export function writeGeneratedRulesNote(configPath: string): void {
  if (!fs.existsSync(configPath)) return; // nothing to annotate yet — `runInit` writes this first

  const existing = fs.readFileSync(configPath, 'utf8');
  const newBlock = block();
  const next = spliceOrAppendBlock(existing, newBlock, configPath, START_MARKER, END_MARKER);
  writeFileAtomic(configPath, next);
}

/**
 * Pre-flight check for `writeGeneratedRulesNote`: throws if `configPath` exists and its note block
 * is malformed, without writing anything. No-ops on a missing config file — mirroring
 * `writeGeneratedRulesNote`'s own early return, since not yet having a config to annotate isn't
 * malformed. Callers with a multi-step write sequence that includes `writeGeneratedRulesNote` (for
 * example `writeBuildArtifacts` in `commands/build.ts`, which also writes
 * `.align/generated-rules.json` and `.align/rules.lock.json`) should call this first, before any
 * step in that sequence writes anything — otherwise a malformed marker state discovered mid-way
 * through `writeGeneratedRulesNote` leaves the other artifacts on disk with no matching lockfile or
 * baseline update (bug hunt 2026-08-03, BUG #10/#11/#12's reachability inside that sequence).
 */
export function assertGeneratedRulesNoteWellFormed(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  assertBlockWellFormed(fs.readFileSync(configPath, 'utf8'), configPath, START_MARKER, END_MARKER);
}
