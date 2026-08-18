import type { RepoRelativePath } from '../types/branded.js';
import type { ScanBlindSpot, ScanBlindSpotReason } from '../types/graph.js';
import type { MovedEntry } from './store.js';

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

/**
 * The same at-or-under containment test, for a consumer whose `dir` came from a HUMAN rather than
 * from a walker — `align baseline prune --forget-unscanned <prefix>` (ADR 028 Stage 4) is the first.
 *
 * It differs from `isUnderBlindSpot` in exactly one place, and that place is the whole reason it is
 * a separate export: `''` means "the entire repository". A walker producing `''` is stating a fact
 * (the scan root itself was unreadable) and every consumer errs toward retention, which is safe. A
 * user's `''` — an empty flag value, a shell variable that expanded to nothing — arriving at a
 * DESTRUCTIVE path would silently mean "forfeit every retained entry in the repository", which is
 * precisely the bare form ADR 028 Stage 4 forbids. Throwing is not defensive programming here; the
 * two callers want opposite answers to the identical input, so one of them has to say which.
 */
export function isUnderRepoPath(file: RepoRelativePath, dir: RepoRelativePath): boolean {
  if (dir === '') {
    throw new Error(
      "isUnderRepoPath: '' is the repository root and would match every file — a caller that means " +
        "'the whole repository' must say so explicitly rather than arrive here with an empty path",
    );
  }
  return isUnderDirectory(file, dir);
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

/**
 * ADR 028 **mechanism 3**, shared by both consumers that must not drift (CLAUDE.md rule 6).
 *
 * True when this file's own directory produced no observed file AND is not on disk — the whole tree
 * is missing, not this one file. A genuine deletion leaves its siblings behind; a partial checkout,
 * a sparse clone or an unfetched tree takes them all with it.
 *
 * **Why this lives in core rather than beside the retention partition that first used it.** It was
 * added to the CLI's delete arm only, and on 2026-08-17 review reproduced the consequence: an orphan
 * in a missing directory was still offered to `applyMoves` for a content-fingerprint match and
 * TRANSFERRED, forging a real human's `acceptedAt`/`acceptedBy` onto a never-reviewed violation —
 * reachable from a plain `align check`, which turned a red repo green at exit 0. A transferred entry
 * never reaches the retention partition, so the delete-arm fix could not see it. That is ADR 027's
 * F1 shape exactly (fixed one arm, missed the other), committed while fixing an instance of it.
 * See `docs/adr/defects/LEDGER.md` D010.
 *
 * BOTH conditions, in this order: the observed-set test is an in-memory short-circuit that answers
 * for the overwhelming majority of candidates without a syscall, and `fileExists` is the one that
 * makes the claim true — "the scan produced nothing here" and "there is nothing here" are different
 * facts, and only the second justifies retaining. A directory that EXISTS but yielded no observed
 * file is a genuine deletion as far as this mechanism is concerned; its remaining contents are
 * assets or files outside the extension set. The cases where such a directory is unobservable for a
 * REASON (excluded, unreadable, a nested checkout) are retained by mechanism 1 before this is
 * consulted, which is why this test can afford to be strict.
 */
export function isUnderAbsentDirectory(
  file: RepoRelativePath,
  observedFiles: ReadonlySet<RepoRelativePath>,
  fileExists: (path: RepoRelativePath) => boolean,
): boolean {
  const dir = directoryOf(file);
  return !anyObservedUnder(dir, observedFiles) && !fileExists(dir as RepoRelativePath);
}

/** The immediate parent directory of a repo-relative path, `''` for a root-level file. Forward
 * slashes only — every producer of `RepoRelativePath` normalizes separators. Deliberately the
 * IMMEDIATE parent, not any ancestor: the tightest directory that can be shown to have produced
 * nothing. */
export function directoryOf(file: RepoRelativePath): string {
  const cut = file.lastIndexOf('/');
  return cut === -1 ? '' : file.slice(0, cut);
}

/** Did this scan observe ANY file under `dir`? `''` (the repo root) is true whenever the scan
 * observed anything at all, which is what keeps mechanism 3 off root-level entries — a
 * manifest-domain entry like `package.json` must never be retained by this arm on a healthy scan. */
export function anyObservedUnder(dir: string, observedFiles: ReadonlySet<RepoRelativePath>): boolean {
  if (dir === '') return observedFiles.size > 0;
  const prefix = `${dir}/`;
  for (const observed of observedFiles) {
    if (observed.startsWith(prefix)) return true;
  }
  return false;
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

/**
 * The move-transfer report (ADR 006, hardened for LEDGER D015 on 2026-08-18).
 *
 * A transfer moves a human's recorded acceptance from one file onto another, and align **cannot
 * prove the violation moved** rather than the old file having been deleted while a content-identical
 * one already existed elsewhere. Reproduced 2026-08-18: baseline `src/api/old.ts`, add an identical
 * never-reviewed violation at `src/api/new.ts` (red), delete `old.ts` — a plain `align check` goes
 * green with `acceptedBy: manual` now sitting on the unreviewed violation, at exit 0.
 *
 * That defect has no sound fix from a single scan: the sound test is "was this candidate already RED
 * last scan", which needs a temporal reference align does not yet keep
 * (`docs/adr/029-2026-08-18-scan-observation-history.md`, `wasViolationObservedAt`). Until it does, this
 * report is the **entire**
 * mitigation, and it is a real one: the count alone ("1 entry transferred") is unreviewable, whereas
 * naming both paths and the consent being carried lets a human reading CI output see that an
 * acceptance they recognise has landed somewhere they do not.
 *
 * It deliberately does NOT cry wolf. Most transfers are ordinary renames and this is an advisory, not
 * a refusal — `align check` stays green. The wording states the limit of align's knowledge rather
 * than implying wrongdoing, because a report users learn to skip is worth nothing (shape S-04).
 *
 * Capped at 5 like every other list align prints (`describeBlindSpots`, `describeRetainedEntries`,
 * `describeUnverifiablePrunes`) — a bulk directory rename must not paste the whole baseline into an
 * advisory.
 */
export function describeMovedEntries(moves: readonly MovedEntry[], limit = 5): string {
  const one = moves.length === 1;
  const shown = [...moves]
    .sort((a, b) => a.fromFile.localeCompare(b.fromFile))
    .slice(0, limit)
    .map((m) => `  ${m.fromFile} → ${m.toFile}  [${m.ruleId}, accepted by ${m.acceptedBy}]`);
  const more = moves.length - shown.length;
  return (
    `${moves.length} ${one ? 'entry' : 'entries'} transferred (file moves) — ` +
    `${one ? 'an accepted violation now points' : 'accepted violations now point'} at a different file:\n` +
    `${shown.join('\n')}${more > 0 ? `\n  +${more} more` : ''}\n` +
    `Review ${one ? 'it' : 'them'} if the path looks unfamiliar: align matches a moved violation by content, ` +
    `so it cannot tell a renamed file from one that was deleted while an identical violation already ` +
    `existed elsewhere — and a transfer carries the original acceptance onto the new path.`
  );
}
