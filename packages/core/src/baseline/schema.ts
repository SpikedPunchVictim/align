/**
 * `.align/baseline.json` wire shape — the missing third sibling of `../fix/schema.ts` and
 * `../build/schema.ts` (zod, parse-don't-validate, CODING_BEST_PRACTICES.md §12). Validates what
 * `packages/cli/src/align-dir.ts`'s `readBaseline` parses off disk: a corrupted or hand-mangled
 * baseline must throw, never silently read as `[]` (bug hunt 2026-08-03, BUG #1) — an empty read
 * followed by `align baseline accept`'s full-snapshot overwrite (`store.snapshot()`) permanently
 * destroys every previously-accepted entry.
 *
 * The authoritative shape is `BaselineEntry` (`./store.ts`). Two constraints mirror it exactly and
 * must never regress:
 *  - `contentFingerprint` (and, by the same discipline, `acceptedValue`) stays optional —
 *    `.align/baseline.json` files written before that field existed (`store.ts`'s own doc comment)
 *    must still parse.
 *  - the object stays open (`.passthrough()`) — a stricter schema would reject any field added to
 *    `BaselineEntry` in the future and turn every existing repo's next `align check` into a hard
 *    error on upgrade.
 */
import { z } from 'zod';

export const baselineEntrySchema = z
  .object({
    fingerprint: z.string().min(1),
    ruleId: z.string().min(1),
    file: z.string().min(1),
    acceptedAt: z.number(),
    acceptedBy: z.enum(['init-seed', 'accept-existing', 'manual']),
    // Optional — see module doc comment. `store.ts`: "Optional so `.align/baseline.json` files
    // written before this field existed still parse."
    contentFingerprint: z.string().min(1).optional(),
    // Optional — same back-compat discipline (FRAGILE #8, bug hunt 2026-08-03). Only present on
    // entries accepted from a `metric`-kind violation; a legacy or non-metric entry simply lacks
    // it, and `gates/advisories.ts`'s growth advisory skips those cleanly rather than crashing.
    acceptedValue: z.number().optional(),
  })
  .passthrough();

/**
 * **The current on-disk shape: an envelope carrying a schema version.**
 *
 * Until 0.2.0 this file was a bare JSON array, which is the one shape with nowhere to put a version —
 * and it was the only structured `.align/` artifact without one (`rules.lock.json`,
 * `generated-rules.json` and `ruleset-ir.json` all carry `irVersion`; `last-scan.json` carries
 * `recordVersion`). `types/scan-history.ts` states the reason that field exists: *"ADR 028's
 * Consequences recorded the cost of NOT having this on `McpCheckPayload` — every rename after 0.2.0
 * is an unsignallable break — and this field is that lesson applied before the fact, for twenty
 * bytes."* The lesson had been applied to a disposable cache and not to the file holding
 * irreplaceable human consent.
 *
 * **What the absence actually cost, precisely.** Back-compat rested entirely on "every new field is
 * optional, and the object is `.passthrough()`". That is sound for ADDITIVE change forever, and
 * silent for SEMANTIC change — and the semantics most likely to change are `fingerprint` and
 * `contentFingerprint`, which are the identity deciding what gets transferred (ADR 006 move-transfer)
 * and what gets pruned. Redefining either hash would leave every existing entry parsing cleanly while
 * meaning something different, with no signal at any layer.
 *
 * **Version 1 is the legacy bare array**, retroactively — it has no marker, and `Array.isArray` is
 * the discriminator (see `readBaseline`). A reader that meets a version it does not know must FAIL,
 * never guess: this file is the one where an empty or misread result is destructive (BUG #1), so the
 * discipline here is the opposite of `.align/last-scan.json`'s deliberate read-as-absent.
 *
 * `.passthrough()` on the envelope for the same reason it is on the entry: a field a later align adds
 * beside `entries` must not make this version reject the file outright.
 */
export const baselineEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    entries: z.array(baselineEntrySchema),
  })
  .passthrough();

/** The version this align writes. Bumped only for a change a previous align would MISREAD — a new
 * optional field is not one (that is what the entry schema's optionality and `.passthrough()` are
 * for), and bumping for one would strand every repository for no gain. */
export const BASELINE_SCHEMA_VERSION = 2;

/**
 * The pre-0.2.0 shape: a bare array of entries, no version marker. Retained as a first-class,
 * exported schema rather than as a fallback branch of a union, because a repository written by any
 * 0.1.x align still has it and reading those correctly is the whole point of versioning the format
 * at all. `readBaseline` picks between this and the envelope on `Array.isArray`, then version-checks
 * the envelope separately so an unknown version produces its own message instead of a shape error.
 */
export const legacyBaselineArraySchema = z.array(baselineEntrySchema);
