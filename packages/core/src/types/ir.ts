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

// Greenfield mode (IMPLEMENTATION_PLAN.md Design Reserve "Greenfield mode", ADR 003 amendment):
// a component's empty-selector policy is a 3-state discriminant, not the old boolean `allowEmpty`.
// - 'fail' (default): a component matching zero files is a load-time error (ADR 003's
//   empty-selector-fails-by-default doctrine, unchanged).
// - 'allow': empty tolerated permanently — the old `allowEmpty: true` behavior, now additionally
//   surfaced as an `ungrounded-component` advisory (`components/registry.ts`'s
//   `findUngroundedComponents`) instead of being silently indistinguishable from real compliance
//   (ADR 008 amendment: the reference-validity invariant's sanctioned exception, made visible).
// - 'until-populated': empty tolerated + surfaced the same way, but self-heals — once the
//   component has >=1 classified file, the empty-check simply stops triggering (no separate
//   "armed" state to track) and its rules evaluate normally. Documents greenfield intent
//   ("this WILL be built") instead of a permanent, easy-to-forget opt-out.
const emptyPolicySchema = z.enum(['fail', 'allow', 'until-populated']);

const componentDefinitionSchema = z.object({
  name: componentName,
  selector: fileSelectorSchema,
  empty: emptyPolicySchema.default('fail'),
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

// External selector (ADR 017 Part A): a permitted TARGET for `arch.no-dependency`'s `to` and a
// permitted entry in `arch.layers`' `canDependOn` — glob-matched against `graph.externalEdges`,
// never `graph.nodes`/`graph.edges` (docs/ir-schema.md's external-selector section pins the exact
// matching semantics: `node:` prefix requires an `ExternalPackageNode.isBuiltin` match, glob over
// `packageName` otherwise). `includeTypeOnly` defaults `false` (mirrors `arch.no-cycles`'
// `includeTypeOnly`) — matched runtime edges only unless a rule author opts in (the browser-safety
// case wants the default off; the §8.3 core-purity "must not import framework *types*" case opts
// in). No new RuleIR *kind* (ADR 017: "two existing kinds gain a target variant") — this is a
// value shape nested inside the two kinds below, not a discriminant of `ruleIRSchema` itself.
const externalSelectorSchema = z.object({
  kind: z.literal('external'),
  pattern: z.string().min(1),
  includeTypeOnly: z.boolean(),
});

// `to`/`canDependOn` entries widen to `ComponentRef | ExternalSelector` (ADR 017 Part A). Back-
// compat is structural, not just behavioral: a rule authored before this change round-trips
// through this schema unchanged (a bare component-name string still parses as the `componentRef`
// arm of the union), and `arch.layers`' opt-in invariant (external edges evaluated only when a
// layer's `canDependOn` names >=1 external selector) is enforced by the evaluator, not this schema.
const dependencyTargetSchema = z.union([componentRef, externalSelectorSchema]);

const archNoDependencySchema = z.object({
  kind: z.literal('arch.no-dependency'),
  id: ruleId,
  from: componentRef,
  to: dependencyTargetSchema,
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
        canDependOn: z.array(dependencyTargetSchema),
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

// `metric` is a single literal today (`'loc'` only — promoted 2026-07-12 on kluster ruleset
// evidence, IMPLEMENTATION_PLAN.md's Promotion log). `fan-in`/`fan-out`/`instability` remain
// reserved (docs/ir-schema.md) pending their own evidence; this is written as a growable
// discriminant (`z.literal('loc')` now, `z.union([...])` when a second metric is promoted) rather
// than a bare `z.string()`, so adding one is additive, never a retrofit of this shape.
const archMetricSchema = z.object({
  kind: z.literal('arch.metric'),
  id: ruleId,
  target: componentRef,
  metric: z.literal('loc'),
  max: z.number().int().positive(),
  provenance: ruleProvenanceSchema,
});

// `security.manifest.*` (ADR 013, promoted 2026-07-12 on docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md probe
// evidence — probe Rules 1 and 7). Both are repo-wide (no `ComponentRef`, same shape as
// `custom.host` — see `rules/component-refs.ts`'s `componentRefsOf`), because the manifest scan
// domain (root + workspace package.json + pnpm-lock.yaml) has no notion of align's
// file-classified components at all.
const securityManifestSourceHygieneSchema = z.object({
  kind: z.literal('security.manifest.source-hygiene'),
  id: ruleId,
  provenance: ruleProvenanceSchema,
});

const securityManifestNewDependencySchema = z.object({
  kind: z.literal('security.manifest.new-dependency'),
  id: ruleId,
  provenance: ruleProvenanceSchema,
});

export const ruleIRSchema = z.discriminatedUnion('kind', [
  archNoDependencySchema,
  archNoCyclesSchema,
  archLayersSchema,
  customHostSchema,
  archMetricSchema,
  securityManifestSourceHygieneSchema,
  securityManifestNewDependencySchema,
]);

export const rulesetIRSchema = z.object({
  irVersion: z.literal('1'),
  components: z.record(componentName, componentDefinitionSchema),
  rules: z.array(ruleIRSchema),
});

export type FileSelector = z.infer<typeof fileSelectorSchema>;
export type EmptyPolicy = z.infer<typeof emptyPolicySchema>;
export type ComponentDefinitionIR = z.infer<typeof componentDefinitionSchema>;
export type RuleProvenance = z.infer<typeof ruleProvenanceSchema>;
export type RuleIR = z.infer<typeof ruleIRSchema>;
export type RulesetIR = z.infer<typeof rulesetIRSchema>;
export type ExternalSelector = z.infer<typeof externalSelectorSchema>;
export type DependencyTarget = z.infer<typeof dependencyTargetSchema>;
export type ArchNoDependencyRule = z.infer<typeof archNoDependencySchema>;
export type ArchNoCyclesRule = z.infer<typeof archNoCyclesSchema>;
export type ArchLayersRule = z.infer<typeof archLayersSchema>;
export type CustomHostRule = z.infer<typeof customHostSchema>;
export type ArchMetricRule = z.infer<typeof archMetricSchema>;
export type SecurityManifestSourceHygieneRule = z.infer<typeof securityManifestSourceHygieneSchema>;
export type SecurityManifestNewDependencyRule = z.infer<typeof securityManifestNewDependencySchema>;
