/**
 * Migration registry contracts (ADR 022, "The migration registry — three tiers, keyed by
 * version"). Lives in the CLI package, not core: validators inspect real repo state (filesystem, a
 * language-plugin scan) and transforms mutate real files — both are I/O, and core stays
 * framework/I-O-free by construction (ADR 021 rejects even core reading its own `package.json`;
 * the same argument applies here, more strongly, since these contracts touch the filesystem
 * directly). Notes are plain data with no I/O dependency of their own, but a note only ever exists
 * as part of the version entry that carries it alongside its validators/transforms, so it lives
 * here too rather than being split into core on its own.
 *
 * Scope of this slice (task #16 slice B): the registry SHAPE, range selection, and the
 * validator/transform contracts. No transform is implemented here — this file defines the contract
 * and the type-level safety net (a transform without a paired validator does not typecheck; see
 * `transform-pairing.typecheck.ts`), not a mutation.
 */

/**
 * Authored prose explaining what changed and why (ADR 022's "Notes" tier). Pure data, no I/O.
 *
 * ADR 022 requires notes to be *compiled* from `UPGRADING.md`, never hand-authored twice (ADR
 * 021's one-record invariant) — `notes-compiler.ts` is that compiler, and `notes.generated.ts`
 * (checked in, produced by `scripts/compile-upgrading-notes.mjs`) is its output. There is
 * therefore no "authored directly in TypeScript" escape hatch for this type any more: every
 * `MigrationNote` a `VersionRegistryEntry` carries must trace back to a `###` section in
 * `UPGRADING.md`.
 */
export interface MigrationNote {
  readonly heading: string;
  readonly body: string;
}

/**
 * One thing a validator observed. Deliberately generic — see `Validator` below — so this slice's
 * one real validator and any future ones share a shape without inventing a discriminated union
 * before a second validator exists to prove what actually varies (CODING_BEST_PRACTICES.md §25,
 * "wait for the rule of three").
 */
export interface ValidatorFinding {
  readonly summary: string;
  /** Repo-relative paths the finding is about, if any — omitted for a finding with no file list. */
  readonly affectedFiles?: readonly string[];
}

/**
 * READ-ONLY. Inspects repo state and reports findings; never mutates. Always run for every entry
 * in a selected range, including under a future `--notes` (ADR 022) — never gated on consent.
 *
 * The type cannot literally forbid a `run` body from calling `fs.writeFileSync` — TypeScript has
 * no effect system to encode "this function performs no writes." What it CAN do, and does here, is
 * withhold any capability an implementation would need to mutate anything on purpose: `run`
 * receives nothing but a root path to read from, no writer/mutator object, nothing to call. That
 * keeps "validators don't mutate" a property of the API surface — there is nothing to mutate
 * WITH — rather than only a promise kept in a doc comment.
 */
export interface Validator {
  readonly id: string;
  readonly description: string;
  run(rootDir: string): Promise<readonly ValidatorFinding[]> | readonly ValidatorFinding[];
}

/**
 * What a transform WOULD do, computed without writing anything — the "blast radius inspectable
 * before it runs" requirement (ADR 022's compensating controls, "Preview by default").
 */
export interface TransformPreview {
  readonly description: string;
  readonly filesAffected: readonly string[];
}

/**
 * MUTATES. Consent-gated — nothing in this slice invokes `apply`; only the contract exists (the
 * command that would gate and invoke it, `align upgrade`, is a later slice).
 *
 * `idempotent` is typed as the literal `true`, not `boolean` — an implementor cannot write
 * `idempotent: false` and still satisfy this interface; the only way to construct a `Transform` at
 * all is to assert the property exists. That does not PROVE the runtime behavior (no type system
 * can prove idempotency), but it does make the claim a required, explicit fact about every
 * transform rather than an assumption nobody wrote down — "expressible and checkable" in the sense
 * the task calls for: expressible as a required field, checkable as "did the author assert it."
 * `preview` must be safe to call at any time (read-only) and is what a consent prompt shows before
 * `apply` ever runs.
 */
export interface Transform {
  readonly id: string;
  readonly description: string;
  readonly idempotent: true;
  preview(rootDir: string): Promise<TransformPreview> | TransformPreview;
  apply(rootDir: string): Promise<void> | void;
}

/**
 * The pairing ADR 022 requires: "every transform requires a validator that detects its
 * precondition... the validator must be runnable standalone." Encoded structurally — a
 * `VersionRegistryEntry`'s `transforms` array holds THIS type, not a bare `Transform`, so
 * constructing a transform entry without a validator is a compile error (proved with
 * `// @ts-expect-error` in `transform-pairing.typecheck.ts`, the same pattern
 * `dsl/reserved-names.typecheck.ts` already uses in core). `validator` is an ordinary `Validator`
 * — nothing about it depends on `transform` — so "runnable standalone" falls out for free: it can
 * (and, per the always-run rule above, always does) run on its own via the entry's validator pass,
 * whether or not `transform.apply` is ever invoked.
 */
export interface TransformWithValidator {
  readonly validator: Validator;
  readonly transform: Transform;
}

/**
 * A per-version registry entry (ADR 022). `version` is the align release this entry describes —
 * see `registry.ts`'s doc comment for how "released" is scoped and enforced in this slice.
 */
export interface VersionRegistryEntry {
  readonly version: string;
  readonly notes: readonly MigrationNote[];
  readonly validators: readonly Validator[];
  readonly transforms: readonly TransformWithValidator[];
}

/**
 * Every validator that must run for one entry — the entry's own `validators` PLUS every
 * transform's paired validator. A transform's validator is never skipped just because `--notes` (or
 * withheld consent) means the transform itself won't run — ADR 022's "always run" rule applies to
 * every validator, paired or not.
 */
export function allValidatorsForEntry(entry: VersionRegistryEntry): readonly Validator[] {
  return [...entry.validators, ...entry.transforms.map((paired) => paired.validator)];
}
