import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex, type Advisory, type GeneratedRulesFile } from '@spikedpunch/align-core';
import { readGeneratedRules, readGeneratedRulesRaw, readRulesLock } from '../align-dir.js';

export interface VerifyResult {
  readonly ok: boolean;
  readonly advisories: readonly Advisory[];
}

const DIVERGENCE_MESSAGE =
  '.align/generated-rules.json does not match rules.lock.json — it was hand-edited or removed after the last `align build --apply`.';

/**
 * Reproducible divergence hash (ADR 011 amendment 2026-08-12): `{ irVersion, docPath, rules }`, in
 * this fixed key order — NOT the file's raw bytes. `generatedAt` is excluded: human-facing
 * provenance, written and schema-validated but never READ by any code, so two builds of
 * byte-identical rules no longer hash differently just because they ran a millisecond apart. One
 * definition, called on both sides of the round trip — here, and in `checkGeneratedRulesDivergence`.
 */
export function reproducibleGeneratedRulesHash(file: Pick<GeneratedRulesFile, 'irVersion' | 'docPath' | 'rules'>): string {
  return sha256Hex(JSON.stringify({ irVersion: file.irVersion, docPath: file.docPath, rules: file.rules }));
}

/**
 * Compares generated-rules.json against the lockfile's stored hash, in two tiers (ADR 011
 * amendment 2026-08-12). Tier 1: `reproducibleGeneratedRulesHash`. Tier 2 (TEMPORARY): every
 * lockfile written before this change stored `sha256Hex` of the raw bytes (`generatedAt`
 * included) — without this fallback, upgrading align and running `--frozen-rules` against an
 * untouched repo would fail tier 1 and falsely report "hand-edited or removed". A legacy-hash match
 * instead reports the distinct `lockfile-predates-reproducible-hash` advisory; only when NEITHER
 * matches is it real divergence. DELETE tier 2 (collapse both failure branches into one) once no
 * supported lockfile can still predate this change — no sooner than the release after 0.2.0 (see
 * UPGRADING.md's `## 0.2.0`), once upgrade paths have had a chance to rebuild.
 */
function checkGeneratedRulesDivergence(rootDir: string, expectedHash: string): readonly Advisory[] {
  const generatedRaw = readGeneratedRulesRaw(rootDir);
  if (generatedRaw === undefined) return [{ kind: 'divergence', message: DIVERGENCE_MESSAGE }];

  let reproducibleHash: string | undefined;
  try {
    const parsed = readGeneratedRules(rootDir);
    reproducibleHash = parsed === undefined ? undefined : reproducibleGeneratedRulesHash(parsed);
  } catch {
    reproducibleHash = undefined; // corrupt/schema-invalid — falls through to the legacy/divergence check
  }
  if (reproducibleHash === expectedHash) return [];

  const legacyHash = sha256Hex(generatedRaw); // TEMPORARY — see doc comment above for removal condition
  if (legacyHash === expectedHash) {
    const message = '.align/rules.lock.json predates align\'s reproducible rules hash — re-run `align build --apply` to refresh it.';
    return [{ kind: 'lockfile-predates-reproducible-hash', message }];
  }
  return [{ kind: 'divergence', message: DIVERGENCE_MESSAGE }];
}

/**
 * `--verify` / `align check --frozen-rules` (ADR 011): red iff the doc's section hashes no longer
 * match the lockfile (`doc-drift`) or generated-rules.json diverges from it (`divergence` — see
 * `checkGeneratedRulesDivergence` for the either-hash transition). No lockfile AND no generated
 * rules is a deliberate no-op (`ok: true`) — `runBuild`'s own `--verify` path treats that as an
 * explicit failure instead, since the user asked specifically to verify build state.
 */
export function verifyFrozenRules(rootDir: string): VerifyResult {
  const lock = readRulesLock(rootDir);
  if (lock === undefined) {
    // ABSENT IS NOT NOTHING when generated-rules.json is sitting next to it (LEDGER D042). This used
    // to return `ok: true` on a missing lockfile unconditionally, described as "a deliberate no-op".
    // That is right for a repo which never ran `align build --apply`, and wrong the moment doc-built
    // rules exist: `loadConfig` merges generated-rules.json into the effective ruleset on every load,
    // so those rules are IN FORCE, and the artifact that says which build produced them is gone.
    //
    // Reachable from a `build --apply` that threw between its writes, a `SIGKILL`, a `git clean` that
    // took the gitignored lockfile but not the committed rules, or a hand-deleted file. The verifier
    // must recognise the STATE rather than any one cause — which is the whole reason this half of the
    // fix exists alongside the atomic write sequence, since no preflight covers a full disk.
    //
    // Same discipline as BUG #1 and ADR 028, in the one place it costs most: this function IS the
    // check for "are the rules in force the rules that were built", so reporting success here is
    // CLAUDE.md rule 6 in the verifier itself.
    if (readGeneratedRulesRaw(rootDir) === undefined) return { ok: true, advisories: [] };
    return {
      ok: false,
      advisories: [
        {
          kind: 'generated-rules-without-lockfile',
          message:
            '.align/generated-rules.json is in force but .align/rules.lock.json is missing, so align cannot tell ' +
            'which document produced the rules it is enforcing — most likely an `align build --apply` that did not ' +
            'finish. Re-run `align build --apply` to rebuild both, or delete .align/generated-rules.json to drop the ' +
            'doc-built rules.',
        },
      ],
    };
  }

  const advisories: Advisory[] = [];
  const absDocPath = path.join(rootDir, lock.docPath);
  if (!fs.existsSync(absDocPath)) {
    advisories.push({ kind: 'doc-drift', message: `${lock.docPath} (referenced by rules.lock.json) no longer exists.` });
  } else {
    const docContentHash = sha256Hex(fs.readFileSync(absDocPath, 'utf8'));
    if (docContentHash !== lock.docContentHash) {
      advisories.push({
        kind: 'doc-drift',
        message: `${lock.docPath} has changed since the last \`align build --apply\` — run it again to refresh generated-rules.json.`,
      });
    }
  }

  advisories.push(...checkGeneratedRulesDivergence(rootDir, lock.generatedRulesContentHash));

  return { ok: advisories.length === 0, advisories };
}
