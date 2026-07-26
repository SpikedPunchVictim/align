/**
 * Public-surface inference contract (ADR 016): the typed data model for "what is workspace
 * package X's public entrypoint, and what symbols are actually reachable through it" — computed
 * without requiring the repo to have already declared `package.json` `exports`/`@public`/
 * `@internal` metadata. Consumed by `inferSurface.ts`'s pure barrel-walk (this package) and
 * produced by `plugin-typescript`'s `entrypoint.ts` (the impure shell that reads `package.json`).
 *
 * Parse, don't validate (CODING_BEST_PRACTICES.md §12): the zod schema IS the type, mirroring
 * `types/ir.ts`'s `z.infer` convention. `RepoRelativePath` is reused verbatim from `branded.ts` —
 * no new brand invented for a concept branded.ts already owns (CODING_BEST_PRACTICES.md §11).
 *
 * GRADED confidence (ADR 016 Round-2 amendment, the one substantive change the falsification spike
 * forced): `EntrypointConfidence` is three-way, not binary. `SPIKE_REPORT.md` Round 2 measured
 * `inferred-unique` (a convention fallback with exactly one candidate) at 100% precision/recall
 * against published npm `.d.ts` for 5 `@nestjs/*` packages — "inferred" means "not declared in
 * package.json," not "unreliable." Only `inferred-none` (no resolvable entrypoint at all) should
 * gate a downstream autofix.
 */
import { z } from 'zod';
import { toRepoRelativePath } from './branded.js';

const repoRelativePathSchema = z.string().transform(toRepoRelativePath);

/** How a package's own entrypoint was established via a `package.json` manifest field.
 * `conditionPath` is only meaningful for the `exports` variant — a package can declare more than
 * one subpath export (langchain's `./output_parsers`), each becoming its own `PackageEntrypoint`. */
const declaredProvenanceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('package.json:exports'), conditionPath: z.string() }),
  z.object({ source: z.literal('package.json:types') }),
  z.object({ source: z.literal('package.json:main') }),
]);

/** The `workspace.ts` filename-convention fallback (`resolveWorkspaceSpecifier`'s own-package
 * candidate list). `candidateCount` is what grades the confidence: exactly one candidate resolving
 * to a real file -> `inferred-unique` (validated at 100% P/R on nest, SPIKE_REPORT.md Round 2);
 * zero (or, unobserved-but-modeled, more than one) -> `inferred-none`. */
const conventionProvenanceSchema = z.object({
  source: z.literal('convention'),
  candidateCount: z.number().int().nonnegative(),
});

const surfaceProvenanceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('package.json:exports'), conditionPath: z.string() }),
  z.object({ source: z.literal('package.json:types') }),
  z.object({ source: z.literal('package.json:main') }),
  conventionProvenanceSchema,
]);

const entrypointConfidenceSchema = z.enum(['declared', 'inferred-unique', 'inferred-none']);

/** One resolved entrypoint for a package. Modeled as a discriminated union on `confidence` so
 * illegal states are unrepresentable (CODING_BEST_PRACTICES.md §10): a `declared`/`inferred-unique`
 * entrypoint ALWAYS has a resolved `file`; an `inferred-none` entrypoint NEVER does (there was
 * nothing to resolve) — `file: null` and a missing/present `file` can't disagree with `confidence`,
 * because the type doesn't allow constructing that combination at all. This round-trips cleanly
 * through a persisted JSON artifact as a zod discriminated union with no separate
 * construction-time agreement check needed (ADR 016 §"Typed contract" design notes). */
const packageEntrypointSchema = z.discriminatedUnion('confidence', [
  z.object({
    confidence: z.literal('declared'),
    file: repoRelativePathSchema,
    provenance: declaredProvenanceSchema,
  }),
  z.object({
    confidence: z.literal('inferred-unique'),
    file: repoRelativePathSchema,
    provenance: conventionProvenanceSchema,
  }),
  z.object({
    confidence: z.literal('inferred-none'),
    file: z.null(),
    provenance: conventionProvenanceSchema,
  }),
]);

/** One symbol reachable from a package's public entrypoint(s), with the barrel chain that proves
 * reachability (Mermaid-renderable, same doctrine as no-cycles/no-dependency violations, ADR 007). */
const publicSurfaceEntrySchema = z.object({
  symbol: z.string(), // the 'default' sentinel included, matching exports.ts
  declaredIn: repoRelativePathSchema, // the file that actually declares/holds the symbol
  reachableVia: z.array(repoRelativePathSchema).readonly(), // entrypoint -> ... -> declaredIn, barrel hops in order
  // The entrypoint's grade, carried down the chain and downgraded by the reachability walk: stays
  // at the entrypoint's own grade only if every hop in this entrypoint's walk resolves; any
  // unresolvable hop or barrel-cycle anywhere in that walk drops every entry it produced to
  // 'inferred-none' (the gate-blocking grade) — see inferSurface.ts's module doc comment for the
  // exact degradation rule this implements.
  confidence: entrypointConfidenceSchema,
});

const surfaceUncertaintyReasonSchema = z.enum([
  'barrel-cycle', // export * chain revisits a file already on the path
  'unresolvable-reexport', // export * from './x' where 'x' doesn't resolve to a scanned node
  'non-source-reexport-target', // export * from a non-.ts/.js file (rare; named, not machinery-heavy)
]);

const surfaceUncertaintyMarkerSchema = z.object({
  file: repoRelativePathSchema,
  reason: surfaceUncertaintyReasonSchema,
});

/** One package's complete inferred public surface. The unit a future @internal/deep-import rule
 * evaluator would consume. */
const packagePublicSurfaceSchema = z.object({
  packageName: z.string(), // WorkspacePackage.name
  entrypoints: z.array(packageEntrypointSchema).readonly(),
  exports: z.array(publicSurfaceEntrySchema).readonly(),
  uncertain: z.array(surfaceUncertaintyMarkerSchema).readonly(),
});

export type DeclaredProvenance = z.infer<typeof declaredProvenanceSchema>;
export type ConventionProvenance = z.infer<typeof conventionProvenanceSchema>;
export type SurfaceProvenance = z.infer<typeof surfaceProvenanceSchema>;
export type EntrypointConfidence = z.infer<typeof entrypointConfidenceSchema>;
export type PackageEntrypoint = z.infer<typeof packageEntrypointSchema>;
export type PublicSurfaceEntry = z.infer<typeof publicSurfaceEntrySchema>;
export type SurfaceUncertaintyReason = z.infer<typeof surfaceUncertaintyReasonSchema>;
export type SurfaceUncertaintyMarker = z.infer<typeof surfaceUncertaintyMarkerSchema>;
export type PackagePublicSurface = z.infer<typeof packagePublicSurfaceSchema>;

export {
  declaredProvenanceSchema,
  conventionProvenanceSchema,
  surfaceProvenanceSchema,
  entrypointConfidenceSchema,
  packageEntrypointSchema,
  publicSurfaceEntrySchema,
  surfaceUncertaintyReasonSchema,
  surfaceUncertaintyMarkerSchema,
  packagePublicSurfaceSchema,
};
