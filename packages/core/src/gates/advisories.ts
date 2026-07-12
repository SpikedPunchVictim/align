import type { UncertaintyMarker, UncertaintyReason } from '../types/graph.js';
import type { Advisory } from './types.js';

/**
 * Groups uncertainty markers by reason (ADR 004's uncertainty vocabulary) into one advisory per
 * reason, each naming its own affected-file count (Stage 2 polish over a single blended count): a
 * lone "N specifiers could not be resolved" told an agent something was uncertain without saying
 * whether it's an asset import (expected, ignorable) or an unresolvable specifier (worth
 * investigating) — those are very different signals bundled into noise.
 */
export function buildUncertaintyAdvisories(uncertain: readonly UncertaintyMarker[]): Advisory[] {
  if (uncertain.length === 0) return [];

  const byReason = new Map<UncertaintyReason, UncertaintyMarker[]>();
  for (const marker of uncertain) {
    const list = byReason.get(marker.reason);
    if (list === undefined) byReason.set(marker.reason, [marker]);
    else list.push(marker);
  }

  return [...byReason.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, markers]) => ({
      kind: 'uncertainty',
      message:
        `${markers.length} specifier(s) across ${new Set(markers.map((m) => m.file)).size} file(s) ` +
        `could not be resolved with certainty and were excluded from the graph — reason: ${reason}.`,
    }));
}
