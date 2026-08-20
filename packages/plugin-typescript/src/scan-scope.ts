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
export const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.build',
  '.history',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'out',
]);
