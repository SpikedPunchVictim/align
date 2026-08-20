/**
 * Directory names the source walk never descends into, shared by the walk and the resolver.
 *
 * **Its own module because both need it and they cannot import each other.** `scanner.ts` imports
 * `TsconfigResolver`, so having the resolver import the set back from `scanner.ts` is an import
 * cycle — which align's own `arch.no-cycles` caught within minutes of the D052 fix being written
 * that way. The constant is data, not behaviour, so a third module costs nothing and the cycle is
 * structural rather than a lint to suppress.
 *
 * Extracted VERBATIM from `scanner.ts` (not retyped): a hand-copied set is how a scan-scope list
 * silently drifts from the walk that is supposed to honour it.
 */
/**
 * Excluded wherever they appear, at ANY depth.
 *
 * `node_modules` because nested installs are real and a vendored tree is never this repository's
 * source; `.git` because it marks a checkout boundary (task #25's nested-checkout handling depends
 * on seeing it). Neither is a package-root-only concern, which is exactly why they are not in the
 * list below.
 */
export const ALWAYS_EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);

/**
 * Excluded only where build output actually lives: at a package root (beside the `package.json`
 * that declares it) or at the repository root — LEDGER D053.
 *
 * **The defect this splits.** These names used to be matched at any depth, so a source directory
 * called `build` was skipped and its files were governed by no rule. Measured in align's own
 * repository: `packages/core/src/build/` holds 14 TypeScript source files and ZERO were scanned, so
 * align's own architecture rules had never evaluated them and its self-dogfood green did not cover
 * them. The exclusion targets a ROLE — generated output — and was implemented as a NAME, so any
 * directory sharing the name inherited it [S-06].
 *
 * **Why "package root" is the right discriminator, and why it is free.** Build output is declared by
 * a manifest and emitted beside it: `<pkg>/dist`, `<pkg>/build`, `<repo>/out`, `<repo>/coverage`. A
 * directory named `build` under `src/` is a module called build. The walk already holds the entry
 * list for the directory it is visiting, so "does this directory contain a package.json" is a
 * lookup in data it just read, not another `stat`.
 *
 * Not `tsconfig`'s `outDir`, which would be more precise and needs the resolver during the walk; not
 * `.gitignore`, whose negation syntax align's glob dialect cannot express. Both were considered and
 * are more machinery than the measured defect justifies.
 */
export const BUILD_OUTPUT_DIR_NAMES = new Set([
  'dist',
  'build',
  '.build',
  '.history',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'out',
]);

/**
 * Conservative "the walk may skip a path containing this segment" test, for the D052 remap in
 * `tsconfig-resolver.ts`.
 *
 * The UNION of both lists, deliberately, even though `BUILD_OUTPUT_DIR_NAMES` is position-dependent
 * in the walk. The resolver has no package-root context — it holds a resolved absolute path, not the
 * directory listing that produced it — and the question it asks is only "should I prefer the
 * workspace inventory's source entry over this?". Over-answering yes is safe there: the remap only
 * fires for a specifier that names a workspace package, and for such a specifier the inventory's
 * answer is the source entry either way. Under-answering would restore D052.
 */
export function mayBeExcludedFromScan(segments: readonly string[]): boolean {
  return segments.some((seg) => ALWAYS_EXCLUDED_DIR_NAMES.has(seg) || BUILD_OUTPUT_DIR_NAMES.has(seg));
}

