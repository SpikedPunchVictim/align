/**
 * Range selection over the migration registry (ADR 022's "the migration registry" section, and the
 * `--notes`/`--from` flags it specifies for a later slice). Given a from-version and the current
 * (to) version, selects the entries that apply, in ascending version order.
 */
import { compareVersions } from '../version-skew.js';
import type { VersionRegistryEntry } from './types.js';

/**
 * `'unknown'` is a real, named member of this type — not `string | undefined` with `undefined`
 * meaning "unknown." See `selectRange`'s doc comment for why: the task is to make the
 * unknown-from-version decision an explicit, visible input at every call site, not a behavior that
 * falls out of how `compareVersions` happens to treat a hole.
 */
export type SelectRangeFrom = 'unknown' | string;

export interface RangeSelection {
  readonly entries: readonly VersionRegistryEntry[];
  readonly from: SelectRangeFrom;
  readonly to: string;
}

/**
 * Selects the registry entries that apply between `from` (exclusive) and `to` (inclusive), sorted
 * ascending by version. Reuses `compareVersions` (`version-skew.ts`) rather than reimplementing
 * version ordering — see that function's doc comment for its numeric
 * `major.minor.patch`-with-string-fallback semantics.
 *
 * **The `from: 'unknown'` decision (ADR 022).** Every pre-0.2.0 install, and every 0.2.0+ repo
 * whose users only ever run `align check` (never a stamping command), has no
 * `.align/version.json` — per ADR 022 that is the PERMANENT, common steady state, not a rare edge
 * case: "every install created before 0.2.0" plus "every repo whose users only run `check`," which
 * the ADR calls out as most repos. Two readings were considered for what an unknown from-version
 * should select:
 *
 *  - **Treat unknown as "nothing selected"** (empty range). Cheap, but wrong for what this feeds:
 *    the ADR's validators are read-only, always-run, and deliberately low-cost so they can run
 *    speculatively without consent. An unknown provenance means align cannot rule out ANY prior
 *    release's change having gone unreconciled in this repo — "assume none apply" would silently
 *    disable the one tier the ADR says "earns the most and risks the least," for the majority of
 *    real installs, at exactly the moment align has no other signal to fall back on.
 *  - **Treat unknown as "select every entry up to `to`"** — the choice made here. It costs nothing
 *    extra (validators are cheap and read-only by contract), and the two possible mistakes are not
 *    symmetric: a false positive under this reading is a wasted validator read; a false negative
 *    under the other reading is a missed detection the user never sees. Given that asymmetry, the
 *    conservative (maximal) selection is the honest default.
 *
 * This is why `from` is typed as `SelectRangeFrom` (`'unknown' | string`) instead of
 * `string | undefined`: a caller (the future `align upgrade`) must explicitly convert "no
 * `.align/version.json`" to the literal `'unknown'` at the call site. That conversion is where the
 * decision above becomes visible in the code, rather than being an accident of whatever
 * `compareVersions(undefined, to)` happened to do.
 *
 * **Downgrade (`from` newer than `to`).** Returns an empty range. Every registered entry describes
 * a forward change; none describe undoing one, so "nothing applies" is the accurate answer, not an
 * error — `align upgrade`'s own refusal/warning behavior for a downgrade is that (later, out of
 * scope) command's concern, not this pure selection function's.
 *
 * **`from === to`.** Also an empty range — nothing between a version and itself.
 *
 * **Entries newer than `to`.** Excluded from every branch: a registry may contain unreleased or
 * future-dated entries (e.g. in a test's synthetic list), and neither an unknown nor a known `from`
 * should surface a change the `to` version hasn't shipped yet.
 */
export function selectRange(registry: readonly VersionRegistryEntry[], from: SelectRangeFrom, to: string): RangeSelection {
  const sorted = [...registry].sort((a, b) => compareVersions(a.version, b.version));

  if (from === 'unknown') {
    return { entries: sorted.filter((entry) => compareVersions(entry.version, to) <= 0), from, to };
  }
  if (compareVersions(from, to) > 0) {
    return { entries: [], from, to }; // downgrade — no forward migration applies
  }
  const entries = sorted.filter((entry) => compareVersions(entry.version, from) > 0 && compareVersions(entry.version, to) <= 0);
  return { entries, from, to };
}
