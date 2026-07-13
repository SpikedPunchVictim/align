/**
 * Imperative shell around `@align/core`'s pure `BaselineStore` (CODING_BEST_PRACTICES.md §15/16:
 * functional core, imperative shell) — all filesystem I/O for `.align/` lives here, not in core.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  exportedRulesetSchema,
  generatedRulesFileSchema,
  rulesLockSchema,
  type BaselineEntry,
  type ExportedRuleset,
  type GeneratedRulesFile,
  type RulesLock,
} from '@align/core';

export const ALIGN_DIR = '.align';
const BASELINE_FILENAME = 'baseline.json';
const GENERATED_RULES_FILENAME = 'generated-rules.json';
const RULES_LOCK_FILENAME = 'rules.lock.json';
const LAST_BUILD_REPORT_FILENAME = 'last-build-report.md';
// Default location for `align export-ir`'s output / `align check --untrusted`'s input (ADR 014).
// Overridable per-invocation via `align export-ir --out <path>` / `align check --ir <path>`.
const RULESET_IR_FILENAME = 'ruleset-ir.json';

export function alignDirPath(rootDir: string): string {
  return path.join(rootDir, ALIGN_DIR);
}

function baselinePath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), BASELINE_FILENAME);
}

export function generatedRulesPath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), GENERATED_RULES_FILENAME);
}

export function rulesLockPath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), RULES_LOCK_FILENAME);
}

export function lastBuildReportPath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), LAST_BUILD_REPORT_FILENAME);
}

export function ensureAlignDir(rootDir: string): void {
  fs.mkdirSync(alignDirPath(rootDir), { recursive: true });
}

export function readBaseline(rootDir: string): BaselineEntry[] {
  const file = baselinePath(rootDir);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as BaselineEntry[]) : [];
  } catch {
    return [];
  }
}

export function writeBaseline(rootDir: string, entries: readonly BaselineEntry[]): void {
  ensureAlignDir(rootDir);
  const sorted = [...entries].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  fs.writeFileSync(baselinePath(rootDir), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

/** Raw on-disk bytes of `.align/generated-rules.json`, or `undefined` if absent — used both to
 * `.parse()` the file (below) and to content-hash it verbatim for divergence detection (ADR 011:
 * a hand-edit to this file must be detectable even if the edit still happens to be valid JSON). */
export function readGeneratedRulesRaw(rootDir: string): string | undefined {
  const file = generatedRulesPath(rootDir);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8');
}

/** Parses and zod-validates `.align/generated-rules.json` (ADR 002 parse-don't-validate) — throws
 * a descriptive error on a corrupted/hand-mangled file rather than silently ignoring it, since
 * silently dropping generated rules would be a false-green (a doc-built rule stops being
 * enforced with no signal). */
export function readGeneratedRules(rootDir: string): GeneratedRulesFile | undefined {
  const raw = readGeneratedRulesRaw(rootDir);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${generatedRulesPath(rootDir)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return generatedRulesFileSchema.parse(parsed);
}

/** Returns the exact raw bytes written, so callers can content-hash the same string that will be
 * read back later (`readGeneratedRulesRaw`) — the divergence-detection hash must be computed over
 * identical serialization on both sides of the round-trip. */
export function writeGeneratedRules(rootDir: string, file: GeneratedRulesFile): string {
  ensureAlignDir(rootDir);
  const raw = `${JSON.stringify(file, null, 2)}\n`;
  fs.writeFileSync(generatedRulesPath(rootDir), raw, 'utf8');
  return raw;
}

export function readRulesLock(rootDir: string): RulesLock | undefined {
  const file = rulesLockPath(rootDir);
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  return rulesLockSchema.parse(raw);
}

export function writeRulesLock(rootDir: string, lock: RulesLock): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(rulesLockPath(rootDir), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

export function writeLastBuildReport(rootDir: string, markdown: string): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(lastBuildReportPath(rootDir), markdown, 'utf8');
}

/** ADR 014's untrusted-mode artifact. Defaults to `.align/ruleset-ir.json`; `align export-ir
 * --out`/`align check --ir` both take an explicit override path (absolute or repo-root-relative)
 * for repos that want to commit it somewhere else or keep more than one exported snapshot. */
export function rulesetIrPath(rootDir: string, override?: string): string {
  if (override !== undefined) return path.isAbsolute(override) ? override : path.join(rootDir, override);
  return path.join(alignDirPath(rootDir), RULESET_IR_FILENAME);
}

/**
 * Reads and zod-validates the exported ruleset (`.align/ruleset-ir.json` by default). Returns
 * `undefined` only when the file doesn't exist — `align check --untrusted`'s caller turns that
 * into a hard refuse-don't-fallback message (ADR 014), never a silent switch to executing
 * align.config.ts. A file that exists but fails to parse as JSON or fails schema validation
 * throws — a corrupted or hand-mangled artifact must never be treated as "absent" (that would
 * silently drop rules, the same false-green class `readGeneratedRules` already guards against).
 */
export function readRulesetIr(rootDir: string, override?: string): ExportedRuleset | undefined {
  const file = rulesetIrPath(rootDir, override);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return exportedRulesetSchema.parse(parsed);
}

export function writeRulesetIr(rootDir: string, data: ExportedRuleset, override?: string): string {
  const file = rulesetIrPath(rootDir, override);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}
