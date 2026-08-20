import { buildExportedRuleset } from '@spikedpunch/align-core';
import { loadConfig } from '../config.js';
import { writeRulesetIr } from '../align-dir.js';
import { reportCliError } from '../cli-error.js';
import { computeConfigSourceFingerprint } from '../ir-staleness.js';

export interface ExportIrOptions {
  /** Overrides the default `.align/ruleset-ir.json` output location (absolute or repo-root-relative). */
  readonly out?: string;
}

/**
 * `align export-ir` (ADR 014) — runs ONCE in a trusted context (imports align.config.ts exactly
 * like `align check` already does) and writes the resulting EFFECTIVE ruleset — hand-authored
 * rules plus any `.align/generated-rules.json` rules already merged in, same `loadConfig` path
 * `align check` uses — as portable JSON. `align check --untrusted` reads this file and never
 * imports align.config.ts at all. Re-run this command (in a trusted checkout, e.g. CI before an
 * agent gets an untrusted clone, or as a pre-commit/release step) whenever align.config.ts or the
 * doc it's built from changes — the artifact is a snapshot, not a live view.
 *
 * Deliberately does not export `hostRules` — predicate functions cannot survive a JSON boundary
 * (ADR 002 amendment) and are unconditionally unavailable under --untrusted regardless
 * (`assertNoCustomHostRules`). A ruleset containing `custom.host` rules exports successfully (this
 * command has no opinion on trusted-mode rule content) but prints an advisory naming them, since
 * `align check --untrusted` against this exact file will refuse to run until they're removed.
 */
export async function runExportIr(rootDir: string, options: ExportIrOptions = {}): Promise<number> {
  // loadConfig can fail six ways, including a corrupt `.align/generated-rules.json` (bug hunt
  // 2026-08-03, BUG #14) — caught here instead of crashing with a raw Node stack trace.
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(rootDir);
  } catch (err) {
    return reportCliError('align export-ir', err);
  }
  const { ruleset, excludes, includeNestedCheckouts } = loaded;
  // LEDGER D067: stamp what the config looked like, so `--untrusted` can notice drift later without
  // executing it. Computed here — in the CLI — because core does no filesystem I/O.
  const exported = {
    ...buildExportedRuleset(ruleset, excludes, undefined, includeNestedCheckouts),
    sourceFingerprint: computeConfigSourceFingerprint(rootDir),
  };
  // `writeRulesetIr` stamps `alignVersion` when the write lands inside `.align/` (ADR 022's write
  // discipline, `align-dir.ts`) and can throw on a corrupted `.align/version.json` — same
  // corrupt-≠-absent discipline as every other artifact reader, caught here rather than left as a
  // raw Node stack trace.
  let writtenTo: string;
  try {
    writtenTo = writeRulesetIr(rootDir, exported, options.out);
  } catch (err) {
    return reportCliError('align export-ir', err);
  }

  const componentCount = Object.keys(exported.ruleset.components).length;
  console.log(`align export-ir: wrote ${exported.ruleset.rules.length} rule(s), ${componentCount} component(s) to ${writtenTo}`);

  const hostRuleIds = exported.ruleset.rules.filter((r) => r.kind === 'custom.host').map((r) => r.id);
  if (hostRuleIds.length > 0) {
    console.log(
      `  advisory: ${hostRuleIds.length} custom.host rule(s) exported (${hostRuleIds.join(', ')}) — ` +
        `\`align check --untrusted\` will refuse to run against this file until they are removed ` +
        `(a host predicate is code, and --untrusted never has a predicate registry to consult).`,
    );
  }

  return 0;
}
