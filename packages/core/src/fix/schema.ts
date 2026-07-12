/**
 * Edit-block apply pipeline — schema half (ADR 010).
 *
 * `FixProposal` is the zod-validated shape an LLM `FixProvider` (Stage 4, `@align/agent`) must
 * emit: search/replace edit blocks, never full files, never line-number diffs. This module has
 * zero LLM-client dependencies — it is just a zod IR, validated the same way any other IR in
 * `@align/core` is validated (parse-don't-validate, CODING_BEST_PRACTICES.md §12). The engine
 * that applies a validated `FixProposal` lives in `./apply.js`.
 */
import { z } from 'zod';

export const editBlockSchema = z.object({
  /** Exact, continuous block present in the file — literal character-for-character match. */
  search: z.string().min(1, 'search must be non-empty'),
  /** Replacement text. Empty string means deletion. */
  replace: z.string(),
  /** Disambiguation hint for the engine only — never injected into file content. */
  nearLine: z.number().int().positive().optional(),
  /** Violation ids this edit addresses (VERIFY attribution / REPAIR context). */
  forViolations: z.array(z.string()).optional(),
});
export type EditBlock = z.infer<typeof editBlockSchema>;

export const fixProposalFileSchema = z.object({
  path: z.string().min(1),
  edits: z.array(editBlockSchema).min(1),
});
export type FixProposalFile = z.infer<typeof fixProposalFileSchema>;

export const suppressionSchema = z.object({
  ruleId: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
});
export type Suppression = z.infer<typeof suppressionSchema>;

export const fixProposalSchema = z.object({
  files: z.array(fixProposalFileSchema).min(1),
  /**
   * Accepted and validated per ADR 010, but dormant in arch-first v1: no lint gates exist yet,
   * so no rule category is suppressible. Any proposal that *uses* this field is rejected by the
   * apply pipeline with "no suppressible rule categories active" — see `apply.ts`.
   */
  suppressions: z.array(suppressionSchema).optional(),
  /** Short rationale — becomes the git commit body. */
  rationale: z.string().min(1),
});
export type FixProposal = z.infer<typeof fixProposalSchema>;
