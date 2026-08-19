import * as fs from 'node:fs';
import * as path from 'node:path';

// The `.align/*` artifacts that are MACHINE-LOCAL rather than portable. Every other one
// (baseline.json, generated-rules.json, ruleset-ir.json) IS meant to be committed, so this must
// never blanket-ignore `.align/` itself.
//
// Two reasons live in this list and they are not the same reason:
//   - telemetry (IMPLEMENTATION_PLAN.md's spec, ADR 015) is opt-in and local-only — a preference,
//     and never meant to be shared.
//   - `last-scan.json` (ADR 029) is gitignored for IDENTITY, not for churn. A record written on
//     machine A is not evidence about machine B's checkout: sparse checkouts, partial clones,
//     volume case-sensitivity and an uninstalled workspace all change what a scan legitimately
//     observes. Committing it would let one machine's observation authorize another machine's
//     deletion, which is shape S-10 with a version-control system in front of it. Diff noise would
//     be a cost argument; this is a correctness one, and it is the reason the entry is not optional.
export const ALIGN_LOCAL_GITIGNORE_ENTRIES = ['.align/telemetry.jsonl', '.align/telemetry-state.json', '.align/last-scan.json'] as const;

/**
 * `align init` ensures the target repo's `.gitignore` excludes align's machine-local files.
 * Idempotent — only appends entries not already present (any line-trimmed match, not just an
 * exact-position match), creates `.gitignore` from scratch if the repo doesn't have one yet.
 * Returns whether it actually wrote anything (so `runInit` can decide whether to print a note).
 *
 * Renamed from `ensureTelemetryGitignored` when ADR 029 added a second, unrelated reason for an
 * entry to be here: a function named for one of its two purposes is how the next entry ends up
 * justified by the wrong argument.
 */
export function ensureAlignLocalFilesGitignored(rootDir: string): boolean {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = ALIGN_LOCAL_GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) return false;

  const trimmed = existing.replace(/\s*$/, '');
  const block = `# align machine-local files — telemetry (opt-in: ALIGN_TELEMETRY=1 / --telemetry / align.config.ts telemetry:true)\n# and the scan-observation record, which is evidence about THIS checkout only (ADR 029).\n${missing.join('\n')}\n`;
  const content = trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
  fs.writeFileSync(gitignorePath, content, 'utf8');
  return true;
}
