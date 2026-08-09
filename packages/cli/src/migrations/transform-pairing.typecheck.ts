/**
 * Compile-time-only proof that a `Transform` without a paired `Validator` cannot be placed into a
 * `VersionRegistryEntry.transforms` array (ADR 022: "every transform requires a validator... "
 * this ADR's "Encode that pairing in the type" instruction). Not a vitest test — vitest never
 * imports this file (it is named `*.typecheck.ts`, matching `pnpm typecheck` / `tsc --noEmit`, the
 * same convention `packages/core/src/dsl/reserved-names.typecheck.ts` already establishes for this
 * codebase). If the `transforms` field's type ever regresses to accept a bare `Transform`, the
 * `@ts-expect-error` directive below becomes unused, which `tsc` reports as an error under this
 * project's default settings — so this file fails to typecheck exactly when the guard it exercises
 * has broken.
 */
import type { Transform, Validator, VersionRegistryEntry } from './types.js';

const exampleValidator: Validator = {
  id: 'example-validator',
  description: 'example',
  run: () => [],
};

const exampleTransform: Transform = {
  id: 'example-transform',
  description: 'example',
  idempotent: true,
  preview: () => ({ description: 'example', filesAffected: [] }),
  apply: () => {},
};

// A bare `Transform` — with no paired validator — must NOT be assignable into `transforms`.
const unpaired: VersionRegistryEntry = {
  version: '9.9.9',
  notes: [],
  validators: [],
  // @ts-expect-error — `transforms` requires `{ validator, transform }`, not a bare `Transform`.
  transforms: [exampleTransform],
};
void unpaired;

// A transform explicitly paired with its precondition validator compiles cleanly.
const paired: VersionRegistryEntry = {
  version: '9.9.9',
  notes: [],
  validators: [],
  transforms: [{ validator: exampleValidator, transform: exampleTransform }],
};
void paired;
