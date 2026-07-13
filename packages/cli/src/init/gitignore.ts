import * as fs from 'node:fs';
import * as path from 'node:path';

// IMPLEMENTATION_PLAN.md's telemetry spec: local-only, opt-in — never meant to be committed.
// Every other `.align/*` artifact (baseline.json, generated-rules.json, ruleset-ir.json) IS meant
// to be committed (align's own `.gitignore` only excludes `.align/cache/` and these two) — this
// must never blanket-ignore `.align/` itself.
const TELEMETRY_GITIGNORE_ENTRIES = ['.align/telemetry.jsonl', '.align/telemetry-state.json'] as const;

/**
 * `align init` ensures the target repo's `.gitignore` excludes telemetry's local-only files.
 * Idempotent — only appends entries not already present (any line-trimmed match, not just an
 * exact-position match), creates `.gitignore` from scratch if the repo doesn't have one yet.
 * Returns whether it actually wrote anything (so `runInit` can decide whether to print a note).
 */
export function ensureTelemetryGitignored(rootDir: string): boolean {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = TELEMETRY_GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) return false;

  const trimmed = existing.replace(/\s*$/, '');
  const block = `# align telemetry (opt-in, local-only — ALIGN_TELEMETRY=1 / --telemetry / align.config.ts telemetry:true)\n${missing.join('\n')}\n`;
  const content = trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
  fs.writeFileSync(gitignorePath, content, 'utf8');
  return true;
}
