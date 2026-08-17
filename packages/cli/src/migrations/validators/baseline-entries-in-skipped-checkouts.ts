/**
 * ADR 022's tier-2 (validator) half for 0.2.0's scan-scope change (task #25): a non-root directory
 * carrying its own `.git` — a submodule, a vendored clone, a linked worktree — is no longer scanned
 * unless the human opts it back in via `align.config.ts`'s `includeNestedCheckouts` export.
 *
 * A repo upgrading from 0.1.x can therefore hold accepted baseline entries whose `file` now sits
 * inside a directory this align no longer looks at. Those violations are **unobservable, not
 * fixed** — the same distinction `scan-blind-spot-retention.ts` draws for the destructive writers,
 * arriving here one level earlier: `align baseline prune`/`align init` silently RETAIN such entries
 * (correctly — deleting them would destroy consent records for violations that still exist), but
 * nothing tells the user the entries have gone quiet. This validator is that telling.
 */
import { isUnderSkippedCheckout, nestedCheckoutPaths, type BaselineEntry, type RepoRelativePath } from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { loadConfig } from '../../config.js';
import { readBaseline } from '../../align-dir.js';
import type { Validator, ValidatorFinding } from '../types.js';

/**
 * One finding per affected checkout directory, naming the directory and every baseline entry under
 * it. Per-directory rather than one lumped finding because the decision the user has to make is
 * per-directory: `includeNestedCheckouts` is a list of paths, and "opt `vendor/a` back in, leave
 * `vendor/b` dormant" is a normal answer.
 *
 * Two skipped checkouts can never nest inside one another (the scanner stops descending at the
 * first `.git` it meets — `walkSourceFiles`, `plugin-typescript/src/scanner.ts`), so no entry is
 * reported twice.
 *
 * Phrasing is deliberately aligned with `describeRetainedEntries` (`scan-blind-spot-retention.ts`),
 * which states this same fact for the prune/init writers — "unobservable, not fixed", and
 * `includeNestedCheckouts` named as the way back in. That function is not CALLED here, though: its
 * subject is entries a destructive write just retained ("Retained N entries…, add them to
 * includeNestedCheckouts **to prune them**"), and this validator retains nothing, writes nothing,
 * and is not recommending a prune — the remediation it points at is the opposite decision. Same
 * fact, different verb; reusing the sentence would misdescribe what happened.
 */
function describeStrandedEntries(dir: RepoRelativePath, entries: readonly BaselineEntry[]): ValidatorFinding {
  const one = entries.length === 1;
  return {
    summary:
      `${entries.length} baseline ${one ? 'entry' : 'entries'} ${one ? 'has its file' : 'have their files'} inside ` +
      `nested checkout '${dir}', which align 0.2.0 auto-excludes from the scan unless it is listed in ` +
      `align.config.ts's includeNestedCheckouts export — so ${one ? 'that violation is' : 'those violations are'} ` +
      `unobservable, not fixed. Add '${dir}' to includeNestedCheckouts to make ${one ? 'it' : 'them'} observable ` +
      `again, or accept that ${one ? 'this entry stays' : 'these entries stay'} dormant.`,
    affectedFiles: entries.map((entry) => entry.file).sort(),
  };
}

/**
 * **What this reads, and nothing else**: `align.config.ts` (via `loadConfig`), the TypeScript
 * scanner's nested-checkout blind spots for this repo, and `.align/baseline.json` (via
 * `readBaseline`, the same reader `align upgrade` itself uses). It writes nothing — the tier's
 * contract, pinned by a write-set assertion in
 * `test/migration-skipped-checkout-baseline-validator.test.ts` (ADR 026: the declared write-set for
 * this validator is EMPTY).
 *
 * **Ordering is the cost control.** The baseline is read FIRST and an empty one short-circuits
 * before the scan runs at all: no accepted entries means no entry can be stranded, so the scan
 * would be pure cost. Validators are "always run, low cost, no consent needed" (ADR 022), and the
 * commonest repo by far — nothing accepted, or nothing accepted inside a checkout — pays a single
 * `fs.existsSync` + one small file read and reports nothing.
 *
 * **Defensive by its own hand, not by `runValidator`'s catch.** `commands/upgrade.ts`'s
 * `runValidator` does wrap this in a try/catch, but the same three failures
 * `globDoubleStarSelectorDriftValidator` handles internally are handled internally here for the
 * same reason: a config that won't load, a scan that throws, and (this validator's own third case)
 * a corrupt `.align/baseline.json` — which `readBaseline` deliberately THROWS on rather than
 * reading as empty (BUG #1) — are all already reported, loudly and precisely, by `align
 * check`/`align doctor`/`align upgrade`'s own baseline read. A validator re-reporting them would be
 * a second, possibly-inconsistent account of one problem. Returning no findings is honest here in a
 * way it would not be for a detector: it means "could not observe", and the command's own error
 * path is what tells the user why.
 */
export const baselineEntriesInSkippedCheckoutsValidator: Validator = {
  id: 'baseline-entries-in-skipped-checkouts',
  description:
    'Flags accepted baseline entries whose file lives inside a nested git checkout that align 0.2.0 ' +
    'auto-excludes from the scan — those violations are unobservable, not fixed.',
  async run(rootDir: string): Promise<readonly ValidatorFinding[]> {
    let baseline: readonly BaselineEntry[];
    try {
      baseline = readBaseline(rootDir);
    } catch {
      return [];
    }
    if (baseline.length === 0) return [];

    const loaded = await loadConfig(rootDir).catch(() => undefined);
    if (loaded === undefined) return [];

    const plugin = new TypeScriptPlugin();
    const graph = await plugin.scanner
      .scan({
        rootDir,
        components: loaded.ruleset.components,
        excludes: loaded.excludes,
        // Honoured, not ignored: a checkout the human already opted back in is scanned, so it never
        // appears among the blind spots and its entries are correctly NOT reported here.
        includeNestedCheckouts: loaded.includeNestedCheckouts,
      })
      .catch(() => undefined);
    if (graph === undefined) return [];

    const findings: ValidatorFinding[] = [];
    // NARROWED to the nested-checkout reason on purpose, and NOT widened to every ADR 028 blind
    // spot (ADR 028 plan, decision 3). This validator reports entries stranded by what 0.2.0
    // CHANGED — checkout auto-exclusion is new in this release, so an entry under one is an upgrade
    // consequence a human should be told about. Symlink and `excludes` blindness are standing bugs
    // that predate 0.2.0; reporting them here would misattribute them to the upgrade.
    for (const dir of [...nestedCheckoutPaths(graph.blindSpots)].sort((a, b) => a.localeCompare(b))) {
      // `isUnderSkippedCheckout` (core) is the single containment predicate for this question —
      // shared with `InMemoryBaselineStore.applyMoves` and `scan-blind-spot-retention.ts`, never
      // re-implemented here (CLAUDE.md rule 6). Called one directory at a time so the finding can
      // name WHICH checkout owns the entries, exactly as `describeRetainedEntries` does.
      const stranded = baseline.filter((entry) => isUnderSkippedCheckout(entry.file, [dir]));
      if (stranded.length === 0) continue;
      findings.push(describeStrandedEntries(dir, stranded));
    }
    return findings;
  },
};
