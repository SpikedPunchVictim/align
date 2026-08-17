import type { RepoRelativePath } from '../types/branded.js';
import type { ScanBlindSpot, ScanBlindSpotReason } from '../types/graph.js';

/**
 * `file` lives at or under `dir` — the single containment test every consumer of "was this path
 * somewhere the scan couldn't see" needs: `InMemoryBaselineStore`'s move-transfer gating
 * (`store.ts`), the CLI's prune/init retention (`packages/cli/src/scan-blind-spot-retention.ts`),
 * the sharper empty-component diagnosis (`components/registry.ts`), and the 0.2.0 migration
 * validator. Lives in core (ADR 027's F1 forged-transfer fix, generalized by ADR 028) because
 * `applyMoves` needs it and core owns the baseline domain — the CLI re-uses this rather than
 * keeping its own copy, so there is exactly one implementation (CLAUDE.md rule 6: hunt the class,
 * not the instance).
 */
function isUnderDirectory(file: RepoRelativePath, dir: RepoRelativePath): boolean {
  // `''` is the scan root in repo-relative terms, so every path in the repository is under it.
  // Without this arm the general test below answers FALSE for every file (`file === ''` fails and
  // nothing starts with `'/'`), which would make the one blind spot that matters most — the scan
  // root itself being unreadable, where align sees nothing at all — protect nothing at all, and
  // `prune` would delete the entire baseline at exit 0. `walkSourceFiles` produces `''` from exactly
  // one exit, its `readdirSync` catch on the root; the excluded arm returns early for `''` and the
  // checkout arm is guarded by `relDir !== ''`.
  if (dir === '') return true;
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * True when `file` lives at or under ANY recorded blind spot — the "still known, even though this
 * scan didn't observe it" test (ADR 028's mechanism 1). Every `ScanBlindSpotReason` variant drops a
 * file from `knownFiles` the exact same way a genuine rename/deletion does, but for an unrelated
 * reason: the file didn't move, the scan simply declined to look at it. Without this,
 * `InMemoryBaselineStore.applyMoves` mistakes that absence for FRAGILE #7's "real rename" signal and
 * goes looking for a content-fingerprint match, which can silently forge the entry's
 * `acceptedAt`/`acceptedBy` onto a genuinely new, never-reviewed violation elsewhere — and
 * `store.prune` deletes the entry as "fixed" at exit 0.
 *
 * Matching is at-or-under because most blind spots are whole subtrees the walk never descended
 * into: one `node_modules` record stands for every file beneath it (that bound is a Stage 1 success
 * criterion, pinned by a scanner test), and one unreadable-directory record stands for a subtree
 * nobody can enumerate even in principle.
 *
 * Input-shape assumption, recorded because this is exported from core's public index: both the
 * file and every blind spot's `path` are normalized repo-relative paths — forward slashes, NO
 * trailing slash. A trailing-slash path (`'vendor/sub/'`) would match nothing. The producer
 * guarantees the shape rather than this function checking it: `walkSourceFiles`
 * (`plugin-typescript/src/scanner.ts`), the sole source of `DependencyGraph.blindSpots`, builds
 * every path as `path.relative(repoRoot, abs).split(path.sep).join('/')`, which never yields a
 * trailing slash — so a runtime guard here would be unreachable code.
 */
export function isUnderBlindSpot(file: RepoRelativePath, blindSpots: readonly ScanBlindSpot[]): boolean {
  return blindSpots.some((spot) => isUnderDirectory(file, spot.path));
}

/** The blind spots that cover `file`, for a consumer that must name the reason rather than just
 * decide retention — retention without a reason reads identically to "nothing to prune" (ADR 028
 * §3, "reasons must be printed"). */
export function blindSpotsCovering(file: RepoRelativePath, blindSpots: readonly ScanBlindSpot[]): readonly ScanBlindSpot[] {
  return blindSpots.filter((spot) => isUnderDirectory(file, spot.path));
}

/**
 * One short human-readable phrase per reason, in ONE place, so `align check`'s advisory, `prune`'s
 * retention report and `init`'s at-risk report cannot describe the same fact three different ways.
 * The `never` arm is the enforcement ADR 028 relies on: adding a `ScanBlindSpotReason` variant
 * without deciding how it reads to a human fails the build here.
 */
export function describeBlindSpotReason(reason: ScanBlindSpotReason): string {
  switch (reason.kind) {
    case 'nested-checkout':
      return 'nested git checkout (has its own .git)';
    case 'excluded':
      return `matched the excludes pattern '${reason.pattern}'`;
    case 'default-excluded-dir':
      return `always-excluded directory name '${reason.name}'`;
    case 'unreadable':
      return `unreadable: ${reason.error}`;
    case 'unparseable':
      return `present but could not be parsed: ${reason.error}`;
    case 'not-regular-file':
      return 'not a regular file (symlink, FIFO or socket — the walk does not follow these)';
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled scan blind spot reason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * `path (reason)` for each spot, deduped, sorted, and capped with `+N more` — the
 * `describeUnverifiablePrunes` (`cli/src/unverified-prune.ts`) precedent, so every capped list in
 * align reads the same.
 *
 * The cap is load-bearing, not cosmetic. `blindSpotsMatchingSelector`
 * (`components/registry.ts`) counts EVERY blind spot as a likely cause for a selector with no
 * literal anchor (`**`, whose static prefix is empty and could match anywhere), and a real repo
 * records hundreds — 200 measured on align's own tree. Uncapped, one component's zero-match error
 * would carry the entire scan-scope record as prose.
 */
export function describeBlindSpots(spots: readonly ScanBlindSpot[], limit = 5): string {
  const unique = [...new Set(spots.map((spot) => `${spot.path} (${describeBlindSpotReason(spot.reason)})`))].sort((a, b) =>
    a.localeCompare(b),
  );
  const shown = unique.slice(0, limit);
  const more = unique.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`;
}

/** The nested-checkout blind spots only, as bare paths. Deliberately narrow (ADR 028 plan,
 * decision 3): the 0.2.0 migration validator reports entries stranded by *that* release's scan-scope
 * change, and symlink/exclude blindness are standing bugs rather than upgrade consequences — so
 * widening it would misreport them. Not a general-purpose accessor; new consumers want
 * `isUnderBlindSpot`. */
export function nestedCheckoutPaths(blindSpots: readonly ScanBlindSpot[]): readonly RepoRelativePath[] {
  return blindSpots.filter((spot) => spot.reason.kind === 'nested-checkout').map((spot) => spot.path);
}

/** The pre-ADR-028 containment test over bare checkout paths, kept for the migration validator
 * described on `nestedCheckoutPaths` above — it holds paths, not `ScanBlindSpot`s, once it has
 * narrowed to the checkout reason. Same at-or-under semantics as `isUnderBlindSpot`. */
export function isUnderSkippedCheckout(file: RepoRelativePath, skippedNestedCheckouts: readonly RepoRelativePath[]): boolean {
  return skippedNestedCheckouts.some((dir) => isUnderDirectory(file, dir));
}
