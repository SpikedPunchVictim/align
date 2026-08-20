import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex, type Advisory, type RulesetIR } from '@spikedpunch/align-core';
import { CONFIG_FILENAME } from './config.js';
import { readRulesetIr, rulesetIrPath } from './align-dir.js';
import { computeRulesetIrHash } from './telemetry/ruleset-hash.js';

/**
 * Does `.align/ruleset-ir.json` still say what `align.config.ts` says? — LEDGER D067.
 *
 * **The defect.** `--untrusted` (ADR 014) reads the exported IR instead of executing the config,
 * and the documented workflow — export in a trusted checkout, `--untrusted` in CI — makes the two
 * drift apart as a matter of routine. Reproduced on the reporter's fixture 08: one tree, one moment,
 * `align check` **green** and `align check --untrusted` **RED**, with neither command, and not
 * `doctor` either, saying the two were reading different rules. Drift is dangerous in both
 * directions — a stale IR keeps enforcing a rule the config dropped (a false red, confusing) and
 * misses a rule it gained (a false green in CI, which is the severity that matters).
 *
 * **Two guards, because the two modes can answer different questions.** A trusted command may load
 * both artifacts and compare them exactly; `--untrusted` may not execute the config at all — that
 * IS the flag — so it compares a fingerprint of the config SOURCE taken at export time. The second
 * is strictly weaker and this module never pretends otherwise: see `describeUntrustedIrStaleness`.
 *
 * Both are ADVISORIES, not verdict changes. The trusted run's own verdict is computed from the live
 * config and is correct; what is wrong is a *different* run elsewhere. Flipping a correct verdict
 * red would punish the person who is not making the mistake.
 */

/** `kind` for every advisory this module produces, so a `--json` consumer can filter on one string. */
export const IR_STALENESS_ADVISORY = 'exported-ir-stale';

export interface LiveRulesetInputs {
  readonly ruleset: RulesetIR;
  readonly excludes: readonly string[];
  readonly includeNestedCheckouts: readonly string[];
}

/**
 * The TRUSTED comparison — exact, and therefore the one that gets to say "does not match".
 *
 * Returns `undefined` when there is nothing to say: no IR on disk (not exporting is a choice, not
 * drift — warning there would fire for every repository that has never used `--untrusted`), or the
 * IR agrees. A malformed IR is reported rather than swallowed, because "align could not read it"
 * and "align read it and it agreed" must never look the same from the outside.
 *
 * `excludes`/`includeNestedCheckouts` are compared alongside the rules: both are exported into the
 * artifact precisely because they change what `--untrusted` scans, so drift in them produces the
 * same divergent answer as drift in a rule.
 */
export function describeTrustedIrStaleness(rootDir: string, live: LiveRulesetInputs, irOverride?: string): Advisory | undefined {
  const file = path.relative(rootDir, rulesetIrPath(rootDir, irOverride)) || rulesetIrPath(rootDir, irOverride);
  let exported: ReturnType<typeof readRulesetIr>;
  try {
    exported = readRulesetIr(rootDir, irOverride);
  } catch (err) {
    return {
      kind: IR_STALENESS_ADVISORY,
      message:
        `${file} could not be read (${err instanceof Error ? err.message : String(err)}), so align cannot tell ` +
        `whether \`align check --untrusted\` would evaluate the same rules this run did. Re-run \`align export-ir\`.`,
    };
  }
  if (exported === undefined) return undefined;

  const differences: string[] = [];
  if (computeRulesetIrHash(exported.ruleset) !== computeRulesetIrHash(live.ruleset)) differences.push('the rules/components');
  if (!sameStrings(exported.excludes, live.excludes)) differences.push('excludes');
  if (!sameStrings(exported.includeNestedCheckouts, live.includeNestedCheckouts)) differences.push('includeNestedCheckouts');
  if (differences.length === 0) return undefined;

  return {
    kind: IR_STALENESS_ADVISORY,
    message:
      `${file} no longer matches ${CONFIG_FILENAME} — ${differences.join(' and ')} differ. ` +
      `\`align check --untrusted\` reads that file instead of executing the config, so it is evaluating ` +
      `different rules than this run did: it can still enforce a rule you removed, and it cannot enforce ` +
      `one you added. Re-run \`align export-ir\` and commit the result.`,
  };
}

/**
 * The UNTRUSTED comparison — deliberately weaker, and it says so out loud.
 *
 * It compares `sourceFingerprint`, stamped by `align export-ir` over the config SOURCE FILES, with
 * the same fingerprint recomputed from disk. No config is executed, which is the whole contract of
 * the flag.
 *
 * **What this cannot see, stated because a silent limit is how absence becomes evidence [S-10].**
 * `align.config.ts` may import another module; editing THAT module changes the effective ruleset and
 * leaves the fingerprint untouched. So a mismatch is proof of drift, and a match is not proof of
 * freshness. The advisory is worded to claim only the first.
 *
 * A missing `sourceFingerprint` — every IR written by 0.2.0 or earlier — reports that align CANNOT
 * tell. Reporting nothing would be indistinguishable from a verified-fresh answer, which is the
 * exact substitution this project keeps finding.
 */
export function describeUntrustedIrStaleness(
  rootDir: string,
  exported: { readonly sourceFingerprint?: string | undefined },
  irOverride?: string,
): Advisory | undefined {
  const file = path.relative(rootDir, rulesetIrPath(rootDir, irOverride)) || rulesetIrPath(rootDir, irOverride);
  const actual = computeConfigSourceFingerprint(rootDir);

  if (exported.sourceFingerprint === undefined) {
    return {
      kind: IR_STALENESS_ADVISORY,
      message:
        `${file} was written by an align that did not record a config fingerprint, so align CANNOT tell whether ` +
        `it is still current — these rules may predate the ${CONFIG_FILENAME} in this checkout. Re-run ` +
        `\`align export-ir\` in a trusted checkout to make this checkable.`,
    };
  }
  if (exported.sourceFingerprint === actual) return undefined;

  return {
    kind: IR_STALENESS_ADVISORY,
    message:
      `${CONFIG_FILENAME} has changed since ${file} was exported, so these rules may not be the ones the config ` +
      `now defines — --untrusted cannot execute the config to find out. Re-run \`align export-ir\` in a trusted ` +
      `checkout and commit the result.`,
  };
}

/**
 * A fingerprint of the files that determine the effective ruleset and that align can read WITHOUT
 * executing anything: the config itself and `.align/generated-rules.json` (ADR 011's doc-built rules
 * are merged into the ruleset by `loadConfig`, so a rebuild of the doc drifts the IR too).
 *
 * Each file contributes `path\0sha256`, joined in a fixed order — so a fingerprint says which files
 * existed as well as what was in them, and deleting `generated-rules.json` moves it. Absent files
 * contribute nothing beyond that absence.
 */
export function computeConfigSourceFingerprint(rootDir: string): string {
  const parts: string[] = [];
  for (const rel of [CONFIG_FILENAME, path.join('.align', 'generated-rules.json')]) {
    const abs = path.join(rootDir, rel);
    let bytes: string;
    try {
      bytes = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // absent, or unreadable — either way this file contributes no content
    }
    parts.push(`${rel.split(path.sep).join('/')} ${sha256Hex(bytes)}`);
  }
  return sha256Hex(parts.join('\n'));
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
