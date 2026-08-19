/**
 * `.align/last-scan.json` wire shape — ADR 029, zod, parse-don't-validate
 * (CODING_BEST_PRACTICES.md §12). Sibling of `./schema.ts`, with one deliberate difference in
 * discipline that is the whole reason this comment exists.
 *
 * **A record that fails this schema is treated as ABSENT, not as an error.** `./schema.ts` documents
 * the opposite rule for `.align/baseline.json` and is right to: that file holds irreplaceable human
 * consent, an empty read there is followed by a full-snapshot overwrite, and BUG #1 is what happens
 * when the two combine. None of that transfers here. This file is a gitignored, machine-local cache
 * align writes and replaces on its own schedule, holding nothing a human authored, and a failed read
 * yields `known: false` from every question on `ScanHistoryProbe` — which ADR 029 §5 defines as
 * *exactly today's behaviour*. Throwing instead would fail every `align check` in the repository, on
 * a file the user cannot see in `git status`, until they deleted it by hand.
 *
 * That is not a hypothetical: ADR 030 §4 was amended one day before this file was written, for the
 * same misapplied rule — a `.align/.lock` that refused to be broken at any age because "corrupt is
 * not absent", which bricked the repository it was protecting. The discipline belongs to files
 * holding irreplaceable data; for a file align owns, creates and deletes, never-treat-as-absent is
 * the UNSAFE direction. ADR 029 §7.4 says "a corrupt record throws"; it is amended by this file's
 * reasoning, recorded in the ADR and in `docs/adr/defects/LEDGER.md`.
 *
 * `.passthrough()` on the objects, same reason as the baseline schema: a stricter schema would
 * reject any field a later align adds, and here that would silently disable the mechanism on every
 * downgrade instead of merely ignoring an unknown key.
 */
import { z } from 'zod';

const observedViolationSchema = z
  .object({
    file: z.string().min(1),
    ruleId: z.string().min(1),
    contentFingerprint: z.string().min(1),
  })
  .passthrough();

const componentObservationSchema = z
  .object({
    matchCount: z.number().int().min(0),
    selectorIdentity: z.string().min(1),
  })
  .passthrough();

export const scanObservationRecordSchema = z
  .object({
    // A literal, not a number: a record from a future align whose shape this version cannot read
    // must fail the parse and be treated as absent, rather than parse partially and answer
    // questions from fields that no longer mean what they meant.
    recordVersion: z.literal(1),
    alignVersion: z.string().min(1),
    scopeIdentity: z.string().min(1),
    observedAt: z.number(),
    // Required, and pre-release shape churn is the reason it can be: a record written by an align
    // that predates this field fails the parse, reads as absent, and is replaced by the same run.
    // The alternative — optional, with `undefined` meaning "unknown" — would put a third state into
    // the one predicate that decides whether a sound record gets overwritten.
    complete: z.boolean(),
    observed: z
      .object({
        source: z.array(z.string()),
        manifest: z.array(z.string()),
      })
      .passthrough(),
    components: z.record(componentObservationSchema),
    ruleDefinitions: z.record(z.string().min(1)),
    violations: z.array(observedViolationSchema),
    // Required, same pre-release-churn reasoning as `complete`: a record written before this field
    // existed fails the parse, reads as absent, and is replaced by the same run. An OPTIONAL field
    // here would mean `undefined` had to be interpreted, and the only safe interpretation is "no
    // retained evidence" — which is exactly the state that lets D030's forgery through.
    retained: z.array(observedViolationSchema),
  })
  .passthrough();
