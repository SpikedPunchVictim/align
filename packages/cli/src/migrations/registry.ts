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
 */
import type { VersionRegistryEntry } from './types.js';
import { globDoubleStarSelectorDriftValidator } from './validators/glob-double-star-drift.js';

export const MIGRATION_REGISTRY: readonly VersionRegistryEntry[] = [
  {
    version: '0.1.4',
    notes: [
      {
        heading: '`.align/version.json` provenance stamp',
        body:
          'align now writes `.align/version.json` whenever it writes anything else under `.align/` ' +
          '(init, build --apply, export-ir, baseline accept/prune, and a check that moves a baseline ' +
          'entry). It records which align version last touched `.align/`, so `align check` and ' +
          '`align doctor` can tell you when your artifacts were written by a different align than the ' +
          'one running now. Nothing to do — this is informational only.',
        placeholder: true,
      },
      {
        heading: 'Component selector `**` now matches whole path segments only',
        body:
          'An interior `**` in a component selector (e.g. `app/**/model.ts`) used to match an ' +
          'arbitrary substring, crossing `/` boundaries — so `app/**/model.ts` could match ' +
          '`app/datamodel.ts`, a file with no matching path-segment boundary at all. It now matches ' +
          'only whole path segments, the way `**` behaves in most other glob dialects. If a selector ' +
          'relied on the old cross-boundary behavior, some files may now match a different component ' +
          'or none at all. This version\'s registered validator detects that drift directly against ' +
          'your repo\'s actual selectors and files, and reports which selectors and how many files ' +
          'are affected.',
        placeholder: true,
      },
    ],
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
