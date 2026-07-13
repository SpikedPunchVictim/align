/**
 * `align export-ir` (ADR 014) — the trusted-mode-only pure builder for the untrusted-mode data
 * source. Zero I/O here (CODING_BEST_PRACTICES.md's functional-core discipline, same as every
 * other file in this directory): the CLI's `export-ir` command loads `align.config.ts` (trusted
 * context, once), calls this with the resulting `RulesetIR` + `excludes`, and writes the result to
 * `.align/ruleset-ir.json` itself. Core never touches the filesystem or imports a config file.
 */
import type { RulesetIR } from '../types/ir.js';
import type { ExportedRuleset } from './schema.js';

export function buildExportedRuleset(
  ruleset: RulesetIR,
  excludes: readonly string[],
  exportedAt: number = Date.now(),
): ExportedRuleset {
  return { irVersion: '1', exportedAt, excludes: [...excludes], ruleset };
}
