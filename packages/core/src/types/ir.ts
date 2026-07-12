/**
 * Ruleset IR (`irVersion: "1"`) — docs/ir-schema.md, ADR 002.
 *
 * Parse, don't validate (CODING_BEST_PRACTICES.md §12): the zod schema IS the type. Every
 * RulesetIR in the system passes through `.parse()` once, at the DSL->IR boundary; nothing
 * downstream re-validates it.
 */
import { z } from 'zod';

const componentName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'component names must match ^[A-Za-z][A-Za-z0-9_-]*$');

const fileSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('glob'), patterns: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('package'), packageNames: z.array(z.string()).min(1) }),
]);

const componentDefinitionSchema = z.object({
  name: componentName,
  selector: fileSelectorSchema,
  allowEmpty: z.boolean(),
});

const componentRef = componentName;

const sourceLineRangeSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
});

const ruleProvenanceSchema = z.object({
  because: z.string().optional(),
  sourceFile: z.string().optional(),
  sourceLineRange: sourceLineRangeSchema.optional(),
  sourceQuote: z.string().optional(),
});

const ruleId = z.string();

const archNoDependencySchema = z.object({
  kind: z.literal('arch.no-dependency'),
  id: ruleId,
  from: componentRef,
  to: componentRef,
  provenance: ruleProvenanceSchema,
});

const archNoCyclesSchema = z.object({
  kind: z.literal('arch.no-cycles'),
  id: ruleId,
  scope: z.union([z.literal('repo'), componentRef]),
  includeTypeOnly: z.boolean(),
  provenance: ruleProvenanceSchema,
});

const archLayersSchema = z.object({
  kind: z.literal('arch.layers'),
  id: ruleId,
  layers: z
    .array(
      z.object({
        layer: componentRef,
        canDependOn: z.array(componentRef),
      }),
    )
    .min(1),
  provenance: ruleProvenanceSchema,
});

const customHostSchema = z.object({
  kind: z.literal('custom.host'),
  id: ruleId,
  hostRuleName: z.string(),
  portable: z.literal(false),
  provenance: ruleProvenanceSchema,
});

export const ruleIRSchema = z.discriminatedUnion('kind', [
  archNoDependencySchema,
  archNoCyclesSchema,
  archLayersSchema,
  customHostSchema,
]);

export const rulesetIRSchema = z.object({
  irVersion: z.literal('1'),
  components: z.record(componentName, componentDefinitionSchema),
  rules: z.array(ruleIRSchema),
});

export type FileSelector = z.infer<typeof fileSelectorSchema>;
export type ComponentDefinitionIR = z.infer<typeof componentDefinitionSchema>;
export type RuleProvenance = z.infer<typeof ruleProvenanceSchema>;
export type RuleIR = z.infer<typeof ruleIRSchema>;
export type RulesetIR = z.infer<typeof rulesetIRSchema>;
export type ArchNoDependencyRule = z.infer<typeof archNoDependencySchema>;
export type ArchNoCyclesRule = z.infer<typeof archNoCyclesSchema>;
export type ArchLayersRule = z.infer<typeof archLayersSchema>;
export type CustomHostRule = z.infer<typeof customHostSchema>;
