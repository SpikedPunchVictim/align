import type { UncertaintyMarker, UncertaintyReason } from '../types/graph.js';
import type { ExternalPackageNode } from '../types/graph.js';
import type { RuleIR } from '../types/ir.js';
import { findUngroundedExternalSelectors } from '../rules/external-match.js';
import type { Advisory } from './types.js';

/**
 * Groups uncertainty markers by reason (ADR 004's uncertainty vocabulary) into one advisory per
 * reason, each naming its own affected-file count (Stage 2 polish over a single blended count): a
 * lone "N specifiers could not be resolved" told an agent something was uncertain without saying
 * whether it's an asset import (expected, ignorable) or an unresolvable specifier (worth
 * investigating) — those are very different signals bundled into noise.
 *
 * Unresolvable EXTERNAL package specifiers are additionally collapsed into a single
 * `missing-dependencies` advisory instead of a per-import wall. This is derived from the scan itself
 * (the markers) — NOT a `node_modules` heuristic — so it fires on a partial install too (e.g. align
 * installed but the target repo's own deps absent), which is exactly the false-green case: without the
 * external edges, any external-edge rule would false-green. The one advisory suppresses the wall and
 * warns the check is provisional (docs/proposals/reconciled-build-order.md #1).
 */
export function buildUncertaintyAdvisories(uncertain: readonly UncertaintyMarker[]): Advisory[] {
  if (uncertain.length === 0) return [];

  // One-pass partition: unresolvable external-package specifiers vs everything else (avoids an
  // O(n²) filter that mattered at 1000s of markers on an uninstalled repo).
  const missing: UncertaintyMarker[] = [];
  const remaining: UncertaintyMarker[] = [];
  for (const marker of uncertain) {
    if (marker.reason === 'unresolvable-specifier' && isExternalPackageSpecifier(marker.specifier)) {
      missing.push(marker);
    } else {
      remaining.push(marker);
    }
  }

  const missingDepsAdvisory: Advisory | undefined =
    missing.length === 0
      ? undefined
      : {
          kind: 'missing-dependencies',
          message:
            `${missing.length} external specifier(s) across ${new Set(missing.map((m) => m.file)).size} ` +
            'file(s) could not be resolved — dependencies appear uninstalled or incomplete; install ' +
            'dependencies for a complete architecture check.',
        };

  const byReason = new Map<UncertaintyReason, UncertaintyMarker[]>();
  for (const marker of remaining) {
    const list = byReason.get(marker.reason);
    if (list === undefined) byReason.set(marker.reason, [marker]);
    else list.push(marker);
  }

  const advisories = [...byReason.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, markers]) => ({
      kind: 'uncertainty',
      message:
        `${markers.length} specifier(s) across ${new Set(markers.map((m) => m.file)).size} file(s) ` +
        `could not be resolved with certainty and were excluded from the graph — reason: ${reason}.`,
    }));

  return missingDepsAdvisory === undefined ? advisories : [missingDepsAdvisory, ...advisories];
}

/** A specifier that is not relative and not absolute is treated as an external package import for
 * the missing-dependencies collapse. Node builtins (`node:fs`, bare `fs`) resolve to `external` in
 * the scanner and therefore never appear as `unresolvable-specifier`; anything left in that reason
 * that isn't a relative/absolute path is assumed to be a missing npm package. */
function isExternalPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/**
 * The `ungroundedComponents` precedent (ADR 008's 2026-07-13 amendment), applied to `external(...)`
 * selectors (ADR 017 Part A): a selector matching zero nodes in `graph.externalNodes` skips ADR
 * 008 reference-validity (banning an absent package is correctly vacuously green) but is surfaced
 * here as an advisory rather than left silently, permanently green — so a typo
 * (`external('lodsh')`) is visible. Unlike `ungroundedComponents` (its own dedicated `CheckRun`
 * field, since it feeds a distinct greenfield-mode UX), this rides the existing generic `Advisory`
 * bucket — the ADR's own wording is "surfaced as an advisory", not "a new CheckRun field".
 */
export function buildUngroundedExternalSelectorAdvisories(rules: readonly RuleIR[], externalNodes: readonly ExternalPackageNode[]): Advisory[] {
  const ungrounded = findUngroundedExternalSelectors(rules, externalNodes);
  if (ungrounded.length === 0) return [];

  return ungrounded
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.pattern.localeCompare(b.pattern))
    .map((u) => ({
      kind: 'ungrounded-external-selector',
      message:
        `external selector '${u.pattern}' (rule '${u.ruleId}') matches no external package/builtin seen ` +
        `in this scan — vacuously green, not confirmed. Likely a typo, or the package genuinely isn't imported.`,
      ruleIds: [u.ruleId],
    }));
}
