/**
 * `.align/version.json` wire shape (ADR 022, ADR 021). Lives in the CLI package, not
 * `@spikedpunch/align-core`, deliberately: unlike `baseline/schema.ts`/`build/schema.ts` (core),
 * nothing in core's pure evaluation logic (`evaluateRule`, the orchestrator, the baseline store)
 * ever needs to read this file — it is consulted only by two CLI-side, I/O-adjacent concerns: the
 * `align check` version-skew advisory (`version-skew.ts`) and the write-discipline choke point
 * (`align-dir.ts`'s `stampAlignVersion`/`recordBaselineReconciled`). Core stays framework/I-O-free by
 * construction (ADR 021's "have core read its own package.json" alternative was rejected for
 * exactly this reason); putting a schema core never consumes into core would be an import with no
 * caller on the other side. `baseline/schema.ts` lives in core only because `BaselineEntry` is a
 * type core's own pure logic (`InMemoryBaselineStore`) operates on — that condition doesn't hold
 * here, so the convention it sets ("schemas live in core") doesn't apply to this artifact.
 *
 * Permissive to unknown keys (`.passthrough()`), following `baseline/schema.ts`'s documented
 * back-compat discipline: a field this binary doesn't recognize — written by a NEWER align, ADR
 * 022's downgrade case — must round-trip through a write by this (older) binary instead of being
 * silently dropped. A stricter schema would make every stamp-writing command an unwitting data-loss
 * point for any future field.
 */
import { z } from 'zod';

/**
 * Two fields, answering two different questions (ADR 022) — this distinction is the entire reason
 * the ADR exists, so it is restated here rather than assumed known:
 *
 *  - `alignVersion` — the version that last wrote ANYTHING under `.align/`. Stamped by every
 *    command that writes an `.align/` artifact (see `align-dir.ts`'s `stampAlignVersion`).
 *  - `baselineReconciledBy` — the version under which the baseline was last DELIBERATELY
 *    reconciled against a check. This is NOT "last writer of baseline.json" — an earlier ADR draft
 *    specified that and was wrong, because `baseline.json` has incidental writers (a move-transfer
 *    on any `align check`, a scoped `baseline accept --rule`) that would make a "last writer" field
 *    read as current after routine CI, defeating the field's purpose. Written ONLY by `align init`
 *    (which seeds it) and `align upgrade` (which reconciles it) — see `recordBaselineReconciled`'s
 *    doc comment in `align-dir.ts`. Optional: absent on every install created before 0.2.0, and
 *    absent even on a 0.2.0+ repo until `align init` has actually run.
 */
export const versionFileSchema = z
  .object({
    alignVersion: z.string().min(1),
    baselineReconciledBy: z.string().min(1).optional(),
  })
  .passthrough();

export type VersionFile = z.infer<typeof versionFileSchema>;
