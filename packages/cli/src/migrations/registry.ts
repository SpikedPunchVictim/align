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
 * **Scoped to the current version only, deliberately — not backfilled to 0.1.0–0.1.3.** Those
 * releases shipped before `.align/version.json` or this registry existed, and ADR 022's own
 * provenance-failure section documents, as its primary evidence, that nothing in this repo can
 * reliably reconstruct what changed in an old release after the fact (the same investigation that
 * failed to date `baseline.json`'s writer). Authoring synthetic notes/validators for those
 * versions now would assert a fact nobody verified — worse than the honest gap. Enforcement here
 * starts at the version this slice ships in and applies going forward: every version from here on
 * must have an entry, but this registry makes no completeness claim about 0.1.0–0.1.3.
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

const CURRENT_ENTRY_VERSION = '0.1.4';

export const MIGRATION_REGISTRY: readonly VersionRegistryEntry[] = [
  {
    version: CURRENT_ENTRY_VERSION,
    notes: COMPILED_NOTES[CURRENT_ENTRY_VERSION] ?? [],
    validators: [globDoubleStarSelectorDriftValidator],
    // No transform this slice (task #16 slice B is registry infrastructure only — see the task's
    // scope note). ADR 022 names "rewrite this selector so its match set is exactly what it was
    // before 0.2.0" as a legitimate future transform candidate for this exact validator's finding,
    // once a transform is actually implemented and paired with it.
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
