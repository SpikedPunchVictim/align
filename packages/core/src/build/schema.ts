/**
 * Wire shapes for `align build` (ADR 011): the tier-1/MCP "rule fragment" input format, the
 * `.align/generated-rules.json` file, and the `.align/rules.lock.json` file. Zod-validated per
 * ADR 002's parse-don't-validate discipline — every fragment and every on-disk build artifact is
 * `.parse()`d once, at its boundary.
 */
import { z } from 'zod';
import { ruleIRSchema } from '../types/ir.js';

const componentRefText = z.string().min(1);

// ---------------------------------------------------------------------------------------------
// Rule fragment: the tier-1 ```align block JSON shape (and the MCP `align_propose_rules` proposal
// input shape) — a RuleIR variant's structural fields, minus `id` and `provenance`. Both of those
// are always assigned by align's build pipeline, never authored: `id` is a deterministic slug
// derived from the fragment's own content (ADR 011's rule-level diff minimization depends on ids
// being content-addressed, not author-assigned) and `provenance` is populated from where the
// fragment was found in the doc (or, for MCP, from what the client agent reports). A fragment MAY
// carry an optional `because` override — sourceQuote is auto-populated into the final rule's
// `because` field either way (ADR 011), but an author can prepend their own rationale text.
// ---------------------------------------------------------------------------------------------

const noDependencyFragmentSchema = z.object({
  kind: z.literal('arch.no-dependency'),
  from: componentRefText,
  to: componentRefText,
  because: z.string().optional(),
});

const noCyclesFragmentSchema = z.object({
  kind: z.literal('arch.no-cycles'),
  scope: z.union([z.literal('repo'), componentRefText]).optional(),
  includeTypeOnly: z.boolean().optional(),
  because: z.string().optional(),
});

const layersFragmentSchema = z.object({
  kind: z.literal('arch.layers'),
  // Exactly one layer entry per fragment (mirrors the DSL's `.layer(x).canOnlyDependOn(...)`,
  // which always produces a single-entry `layers` array) — keeps rule ids content-addressed
  // one-layer-per-id (`arch.layers:<layer>`), the same scheme `dsl/index.ts` uses. A doc
  // expressing constraints for two layers writes two bullets/blocks, not one fragment with two
  // entries.
  layers: z.array(z.object({ layer: componentRefText, canDependOn: z.array(componentRefText) })).length(1),
  because: z.string().optional(),
});

const customHostFragmentSchema = z.object({
  kind: z.literal('custom.host'),
  hostRuleName: z.string(),
  because: z.string().optional(),
});

// `arch.metric` (max-LOC only, promoted 2026-07-12 on kluster ruleset evidence,
// IMPLEMENTATION_PLAN.md's Promotion log) — mirrors the DSL's `.maxLinesPerFile(max)` (dsl/index.ts).
const metricFragmentSchema = z.object({
  kind: z.literal('arch.metric'),
  target: componentRefText,
  metric: z.literal('loc'),
  max: z.number().int().positive(),
  because: z.string().optional(),
});

export const ruleFragmentSchema = z.discriminatedUnion('kind', [
  noDependencyFragmentSchema,
  noCyclesFragmentSchema,
  layersFragmentSchema,
  customHostFragmentSchema,
  metricFragmentSchema,
]);

export type RuleFragment = z.infer<typeof ruleFragmentSchema>;

// ---------------------------------------------------------------------------------------------
// `.align/generated-rules.json` — a RuleIR array with full provenance, imported by the config
// loader (packages/cli/src/config.ts). Deliberately NOT a full RulesetIR: `components` stays
// authored once in align.config.ts, never duplicated into the generated artifact.
// ---------------------------------------------------------------------------------------------

export const generatedRulesFileSchema = z.object({
  irVersion: z.literal('1'),
  docPath: z.string(),
  generatedAt: z.number(),
  rules: z.array(ruleIRSchema),
});

export type GeneratedRulesFile = z.infer<typeof generatedRulesFileSchema>;

// ---------------------------------------------------------------------------------------------
// `.align/rules.lock.json` — section hashes <-> rule ids, plus the generated-rules.json content
// hash (divergence detection: a hand-edit to the generated artifact changes this hash without a
// matching lockfile update).
// ---------------------------------------------------------------------------------------------

const lockSectionSchema = z.object({
  anchor: z.string(),
  headingText: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  contentHash: z.string(),
  tier: z.enum(['verbatim', 'bullet', 'prose', 'empty']),
  ruleIds: z.array(z.string()),
});

export type LockSection = z.infer<typeof lockSectionSchema>;

export const rulesLockSchema = z.object({
  irVersion: z.literal('1'),
  docPath: z.string(),
  docContentHash: z.string(),
  builtAt: z.number(),
  sections: z.array(lockSectionSchema),
  generatedRulesContentHash: z.string(),
});

export type RulesLock = z.infer<typeof rulesLockSchema>;
