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
 *  - `contentFingerprint` stays optional — `.align/baseline.json` files written before that field
 *    existed (`store.ts`'s own doc comment) must still parse.
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
  })
  .passthrough();

export const baselineFileSchema = z.array(baselineEntrySchema);
