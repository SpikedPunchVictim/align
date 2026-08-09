/**
 * The one real validator this slice ships (ADR 022's headline 0.2.0 candidate): detects component
 * selectors whose real match set differs between the pre-0.2.0 `**` semantics and the current
 * whole-segment semantics (commit 6d6c9c1).
 */
import { globMatch } from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { loadConfig } from '../../config.js';
import { legacyGlobMatch } from '../legacy-glob.js';
import type { Validator, ValidatorFinding } from '../types.js';

/**
 * **What this actually detects, precisely — no more:** for every glob-kind selector pattern
 * containing an interior `**` immediately followed by a `/` (the only construct commit 6d6c9c1
 * changed; a trailing `**` is byte-for-byte unchanged, so a pattern without that interior form is
 * skipped entirely — nothing to compare), this runs BOTH the pre-fix and current matcher against
 * every file this repo's own scan already inventories, and reports the symmetric difference: files
 * that matched one way but not the other, with counts and the affected paths.
 *
 * **What this does NOT detect.** Which OTHER component (if any) a newly-unmatched file would land
 * in under first-match-wins, or whether a newly-matched file was previously claimed by an
 * earlier-declared component. Answering that would require re-running FULL classification —
 * including `package:`-kind selector resolution against the workspace inventory, which this
 * validator never touches — under both semantics and diffing the per-file component assignment.
 * That is a strictly larger validator than this slice builds. This one answers "did this
 * selector's own match set change, and by how much" — a real, non-guessed detection, per ADR 022's
 * "align can compute both semantics" — not "where did each affected file end up."
 *
 * A config-load or scan failure returns no findings rather than throwing: those failures are
 * already reported by `align check`/`align doctor` themselves, and a validator duplicating that
 * noise would be a second, possibly-inconsistent report of the same problem.
 */
export const globDoubleStarSelectorDriftValidator: Validator = {
  id: 'glob-double-star-selector-drift',
  description:
    'Flags glob-kind component selectors containing an interior `**/` whose match set differs ' +
    'between the pre-0.2.0 (cross-segment) and current (whole-segment) `**` semantics.',
  async run(rootDir: string): Promise<readonly ValidatorFinding[]> {
    const loaded = await loadConfig(rootDir).catch(() => undefined);
    if (loaded === undefined) return [];

    const plugin = new TypeScriptPlugin();
    const graph = await plugin.scanner
      .scan({ rootDir, components: loaded.ruleset.components, excludes: loaded.excludes })
      .catch(() => undefined);
    if (graph === undefined) return [];

    const allFiles = graph.nodes.map((node) => node.file);
    const findings: ValidatorFinding[] = [];

    for (const [name, def] of Object.entries(loaded.ruleset.components)) {
      if (def.selector.kind !== 'glob') continue;
      for (const pattern of def.selector.patterns) {
        if (!pattern.includes('**/')) continue; // trailing `**` is unaffected — nothing to compare

        const oldMatches = new Set(allFiles.filter((file) => legacyGlobMatch(pattern, file)));
        const newMatches = new Set(allFiles.filter((file) => globMatch(pattern, file)));
        const lost = [...oldMatches].filter((file) => !newMatches.has(file));
        const gained = [...newMatches].filter((file) => !oldMatches.has(file));
        if (lost.length === 0 && gained.length === 0) continue;

        findings.push({
          summary:
            `Component '${name}' selector '${pattern}': ${lost.length} file(s) no longer match under ` +
            `the new whole-segment \`**\` semantics, ${gained.length} file(s) newly match.`,
          affectedFiles: [...lost, ...gained].sort(),
        });
      }
    }
    return findings;
  },
};
