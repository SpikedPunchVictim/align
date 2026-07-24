import type { UncertaintyMarker, UncertaintyReason } from '../types/graph.js';
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
