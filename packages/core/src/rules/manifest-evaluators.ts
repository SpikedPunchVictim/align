/**
 * `security.manifest.*` evaluators (ADR 013) — pure functions over a `ManifestInventory`, the
 * disjoint sibling of `evaluators.ts`'s graph-based `RuleEvaluator` family. Same discipline: no
 * I/O, no mutation, fully testable with plain data (CODING_BEST_PRACTICES.md §14).
 */
import { toRuleId } from '../types/branded.js';
import type { SecurityManifestNewDependencyRule, SecurityManifestSourceHygieneRule } from '../types/ir.js';
import type { ManifestDependency, ManifestInventory, ManifestRecord } from '../types/manifest.js';
import type { Violation } from '../types/violation.js';
import { computeFingerprint } from '../baseline/fingerprint.js';
import { becauseField } from './evaluators.js';

export type SecurityManifestRule = SecurityManifestSourceHygieneRule | SecurityManifestNewDependencyRule;

/** git/http(s)/file/link — not registry, not `workspace:`, not an `npm:` alias (an alias still
 * resolves through the registry under a different name, so it correctly never matches here). Same
 * pattern spike/MANIFEST_PROBE_REPORT.md Rule 1 verified 3/3 real, 0 false positives against n8n. */
function classifySourceType(specifier: string): 'git' | 'http' | 'file' | 'link' | undefined {
  if (/^https?:\/\//.test(specifier)) return 'http';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(specifier)) return 'git';
  if (/^file:/.test(specifier)) return 'file';
  if (/^link:/.test(specifier)) return 'link';
  return undefined;
}

function snippetFor(manifest: ManifestRecord, dep: ManifestDependency): { readonly range: { readonly startLine: number; readonly endLine: number }; readonly snippet: string } {
  if (dep.line === undefined) {
    return { range: { startLine: 1, endLine: 1 }, snippet: `"${dep.name}": "${dep.specifier}"` };
  }
  const rawLine = manifest.raw.split('\n')[dep.line - 1];
  return {
    range: { startLine: dep.line, endLine: dep.line },
    snippet: rawLine !== undefined ? rawLine.trim() : `"${dep.name}": "${dep.specifier}"`,
  };
}

/**
 * `security.manifest.source-hygiene` (ADR 013, probe Rule 1): any dependency specifier resolving
 * to git/http(s)/file/link, not registry/workspace protocol. Fingerprint keyed on
 * (manifest file, dep name) only — never the specifier value or a line number — so a git-ref bump
 * or manifest reformatting doesn't reset baseline consent (ADR 013's name-level doctrine, mirrored
 * from `security.manifest.new-dependency`); the current specifier is still reported as a
 * structured field so a reviewer sees exactly what changed.
 */
export const evaluateSourceHygiene = (rule: SecurityManifestSourceHygieneRule, inventory: ManifestInventory): Violation[] => {
  const violations: Violation[] = [];
  for (const manifest of inventory.manifests) {
    for (const dep of manifest.dependencies) {
      const sourceType = classifySourceType(dep.specifier);
      if (sourceType === undefined) continue;

      const id = computeFingerprint(['manifest-source-hygiene', rule.id, manifest.file, dep.name]);
      const { range, snippet } = snippetFor(manifest, dep);
      violations.push({
        id,
        ruleId: toRuleId(rule.id),
        category: 'security',
        severity: 'error',
        file: manifest.file,
        range,
        snippet,
        fixHint: { code: 'manual-review' },
        ...becauseField(rule.provenance.because),
        kind: 'manifest-source-hygiene',
        depName: dep.name,
        specifier: dep.specifier,
        sourceType,
      });
    }
  }
  return violations;
};

/**
 * `security.manifest.new-dependency` (ADR 013, probe Rule 7): a stateless, fingerprint-driven
 * re-expression of the probe's git-diff mechanism through align's existing baseline-consent
 * machinery (ADR 006), not a git-history diff itself — this evaluator flags EVERY current
 * runtime/dev dependency as a fingerprinted candidate on every run; baseline consent (`align
 * init`/`baseline accept`) is what turns "all of today's deps" into "nothing," so only a
 * genuinely new dependency (new name, not previously baselined) ever shows red. Name-level only
 * (`optionalDependencies`/`peerDependencies` excluded) — version-level gating is a documented
 * follow-up (ADR 013), not built here: it would fire on every routine version bump / renovate PR.
 */
export const evaluateNewDependency = (rule: SecurityManifestNewDependencyRule, inventory: ManifestInventory): Violation[] => {
  const violations: Violation[] = [];
  for (const manifest of inventory.manifests) {
    for (const dep of manifest.dependencies) {
      if (dep.field !== 'dependencies' && dep.field !== 'devDependencies') continue;

      const id = computeFingerprint(['manifest-new-dependency', rule.id, manifest.file, dep.name]);
      const { range, snippet } = snippetFor(manifest, dep);
      violations.push({
        id,
        ruleId: toRuleId(rule.id),
        category: 'security',
        severity: 'error',
        file: manifest.file,
        range,
        snippet,
        fixHint: { code: 'manual-review' },
        ...becauseField(rule.provenance.because),
        kind: 'manifest-new-dependency',
        depName: dep.name,
        specifier: dep.specifier,
        depField: dep.field,
      });
    }
  }
  return violations;
};

/**
 * Exhaustive dispatcher for the manifest scan domain — the sibling of `evaluators.ts`'s
 * `evaluateRule`, over the disjoint `SecurityManifestRule` union instead of the full `RuleIR`
 * union. `GateOrchestrator`'s `security` gate is the only real caller (`ruleCategoryOf` partitions
 * `RulesetIR.rules` before this ever runs, `rules/rule-category.ts`).
 */
export function evaluateManifestRule(rule: SecurityManifestRule, inventory: ManifestInventory): readonly Violation[] {
  switch (rule.kind) {
    case 'security.manifest.source-hygiene':
      return evaluateSourceHygiene(rule, inventory);
    case 'security.manifest.new-dependency':
      return evaluateNewDependency(rule, inventory);
    default: {
      const exhaustive: never = rule;
      throw new Error(`unhandled manifest rule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
