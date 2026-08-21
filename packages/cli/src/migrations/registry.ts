/**
 * The migration registry (ADR 022): one entry per released align version, applied in ascending
 * order across a detected range (`range.ts`'s `selectRange`).
 *
 * **"Released" here means "shipped in `packages/cli/package.json`'s `version` field."**
 * `migration-registry-completeness.test.ts` reads that file directly (not the in-process
 * `ALIGN_VERSION` constant, so the check holds even if that constant's own resolution ever
 * changes) and asserts the CURRENT version has an entry — so bumping the version without adding
 * one breaks CI, which is ADR 022's own words: "a released version with no registry entry is a
 * build failure, not an empty section."
 *
 * **Scoped to the current version only, deliberately — not backfilled to 0.1.0–0.1.4.** Those
 * releases shipped before `.align/version.json` or this registry existed, and ADR 022's own
 * provenance-failure section documents, as its primary evidence, that nothing in this repo can
 * reliably reconstruct what changed in an old release after the fact (the same investigation that
 * failed to date `baseline.json`'s writer). Authoring synthetic notes/validators for those
 * versions now would assert a fact nobody verified — worse than the honest gap. Enforcement here
 * starts at the version this slice ships in and applies going forward: every version from here on
 * must have an entry, but this registry makes no completeness claim about 0.1.0–0.1.4.
 *
 * **0.1.4 deliberately has no entry, and once did.** An earlier revision keyed this registry — and
 * `UPGRADING.md`'s corresponding section — to `0.1.4`, describing the fingerprint-churn fixes, the
 * `**` selector change and the `.align/version.json` stamp as though they had shipped in it. They
 * had not: the `v0.1.4` tag is the published release, and every one of those commits lands after
 * it. The notes were describing unreleased work under a released version's name. Keying them to
 * 0.2.0, where they actually ship, is what makes `align upgrade --from 0.1.4` correct — under the
 * old keying it selected entries strictly newer than 0.1.4 and so skipped the very notes a 0.1.4
 * user most needed. The published 0.1.4 therefore has no entry because nothing shipped in it that
 * this registry is in a position to describe.
 *
 * **Notes come from `notes.generated.ts`, never a hand-typed literal here** (ADR 022, ADR 021's
 * one-record invariant). That file is compiled from the repo-root `UPGRADING.md` by
 * `scripts/compile-upgrading-notes.mjs` (`notes-compiler.ts` is the actual compiler; the script is
 * just the I/O around it) — see that generated file's own doc comment for how its content reaches
 * a published, installed `align` even though `UPGRADING.md` itself does not ship in the npm
 * package. `migration-notes-drift.test.ts` fails if `notes.generated.ts` falls out of sync with
 * `UPGRADING.md`'s current text (its embedded content hash no longer matches).
 *
 * **`hasNotesForVersion` extends the completeness invariant above from "has an entry" to "the
 * entry has notes".** ADR 022, verbatim: a missing entry "would otherwise render as 'nothing to
 * know about this version,' which is the false-green shape — silence read as an all-clear." An
 * entry that exists but carries zero notes is the identical false-green shape one layer down, so
 * it is checked as its own predicate rather than folded into `hasEntryForVersion` (which must stay
 * true for "entry exists, notes pending" during authoring — the two questions are genuinely
 * different and collapsing them would make the first check's own failure message ambiguous about
 * which condition actually failed).
 */
import type { VersionRegistryEntry } from './types.js';
import { COMPILED_NOTES } from './notes.generated.js';
import { globDoubleStarSelectorDriftValidator } from './validators/glob-double-star-drift.js';
import { baselineEntriesInSkippedCheckoutsValidator } from './validators/baseline-entries-in-skipped-checkouts.js';
import { globDoubleStarSelectorRewriteTransform } from './transforms/glob-double-star-rewrite.js';

/**
 * One constant per released version with an entry, NOT a single mutable "current" pointer.
 *
 * This was `const CURRENT_ENTRY_VERSION = '0.2.0'` feeding the registry's only entry, and bumping
 * that literal to `'0.2.1'` re-keyed the 0.2.0 entry instead of adding one — silently taking
 * 0.2.0's two validators and its `**`-selector transform away from every user who had not yet
 * upgraded past 0.2.0. That is precisely the re-key defect this file's header already describes
 * happening once before (keyed to 0.1.4, describing work that shipped later), and it is why this
 * registry is a LIST applied in ascending order across a detected range rather than a pointer at
 * the newest thing. Caught by three tests in `migration-skipped-checkout-baseline-validator.test.ts`
 * plus `upgrade.test.ts`'s `--notes` case, which are named for the 0.2.0 entry precisely so a
 * re-key cannot pass quietly.
 *
 * Adding a release means adding a constant and an entry here. It does not mean editing one.
 */
const V0_2_0 = '0.2.0';
const V0_2_1 = '0.2.1';

export const MIGRATION_REGISTRY: readonly VersionRegistryEntry[] = [
  {
    version: V0_2_0,
    // Sourced from the compiled notes by key, never hand-typed here (ADR 021's one-record
    // invariant) — `UPGRADING.md` is the single authored record and `notes.generated.ts` is its
    // compiled form. `hasNotesForVersion` is what turns an empty result into a build failure now
    // that this version is the released one.
    notes: COMPILED_NOTES[V0_2_0] ?? [],
    validators: [globDoubleStarSelectorDriftValidator, baselineEntriesInSkippedCheckoutsValidator],
    // task #16 slice E: "rewrite this selector so its match set is exactly what it was before
    // 0.2.0" (ADR 022's headline 0.2.0 transform candidate), paired with the validator above per
    // its own precondition.
    //
    // `baselineEntriesInSkippedCheckoutsValidator` gets **no transform, deliberately** — ADR 022
    // admission criterion 2: a transform's remediation must be "mechanical and unambiguous — one
    // correct answer, derivable from state align can already observe." Here the two available
    // answers (opt the checkout back in via `includeNestedCheckouts`, or let the entries stay
    // dormant) are an *intent* decision about whether that subtree is part of this repo's
    // architecture at all, which nothing align can observe decides. Per the same criterion,
    // "anything requiring authorial intent stays validator-only", and ADR 022 names that a correct
    // end state, not an unfinished one: "Some validators will never acquire a transform."
    transforms: [{ validator: globDoubleStarSelectorDriftValidator, transform: globDoubleStarSelectorRewriteTransform }],
  },
  {
    version: V0_2_1,
    notes: COMPILED_NOTES[V0_2_1] ?? [],
    // **No validators and no transforms, and that is a claim, not an omission.** ADR 022's entries
    // exist to carry a user across a change align made to their repository's state. 0.2.1's fixes
    // (LEDGER D063–D067) change what align REPORTS, not how it identifies anything:
    //
    //   - D065 rewords the `arch.layers` message for an unmapped target. Verified against
    //     `git diff` on `evaluators.ts`: no `computeFingerprint` call site changed, so no accepted
    //     baseline entry is re-identified and there is nothing to migrate.
    //   - D063 makes a `custom.host` predicate that cannot distinguish its own findings an ERROR
    //     rather than a silent collapse. The fingerprint formula is untouched; the refusal is its
    //     own signal, and it names the file and the fix in the message.
    //   - D066 renames an uncertainty REASON on a per-edge marker — a diagnostic, never a
    //     fingerprint input.
    //   - D064 and D067 are a CLI argument fix and a new advisory. Neither touches stored state.
    //
    // A validator that fires on nothing would be worse than none: it would imply align had checked
    // something. If a later 0.2.x does move fingerprints, it earns its own entry with its own
    // validator — that is what the list is for.
    validators: [],
    transforms: [],
  },
];

/** ADR 022's completeness invariant, as a predicate a test can assert against directly. */
export function hasEntryForVersion(registry: readonly VersionRegistryEntry[], version: string): boolean {
  return registry.some((entry) => entry.version === version);
}

/** The same invariant, one layer deeper: does the version's entry actually carry notes? See this
 * file's module doc comment for why this is a separate predicate rather than folded into
 * `hasEntryForVersion`. */
export function hasNotesForVersion(registry: readonly VersionRegistryEntry[], version: string): boolean {
  const entry = registry.find((e) => e.version === version);
  return entry !== undefined && entry.notes.length > 0;
}
