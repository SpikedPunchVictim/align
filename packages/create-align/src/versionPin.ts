/**
 * Lockstep version pinning (ecosystem norm — vitest/refine model): `create-align` installs
 * `@spikedpunch/align-cli` and `@spikedpunch/align-core` pinned to its OWN version, read at
 * runtime from its own package.json (`nodeEffects.ts`'s `readOwnVersion`), never hardcoded here —
 * a release bump of `create-align` automatically pins the matching `align-cli`/`align-core`
 * release with zero edits to this file.
 */
export function buildPinnedDevDependencySpecs(ownVersion: string): readonly string[] {
  return [`@spikedpunch/align-cli@${ownVersion}`, `@spikedpunch/align-core@${ownVersion}`];
}
