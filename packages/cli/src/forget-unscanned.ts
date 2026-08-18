import { isUnderRepoPath, toRepoRelativePath, type RepoRelativePath } from '@spikedpunch/align-core';
import type { RetainedCandidate } from './scan-blind-spot-retention.js';

/**
 * `align baseline prune --forget-unscanned <prefix>` (ADR 028 Stage 4) — the way back out of
 * retention.
 *
 * Stages 1-2 made align retain any entry whose absence it cannot explain. Left alone that is a
 * one-way ratchet: a repository that permanently excludes a vendored tree, or deletes one behind an
 * `excludes` pattern, accumulates consent records for violations that no longer exist and has no
 * command that will remove them. ADR 028's own Consequences names this ("a slow leak"), and the
 * decided fix is an EXPLICIT forfeiture rather than a heuristic that decides when retention has gone
 * on long enough — align cannot tell a permanently-vendored tree from a temporarily-unreadable one,
 * and the human can.
 *
 * The flag is destructive, so it carries the destructive discipline rather than a lighter one:
 *   - it does not bypass ADR 023's guards (the caller runs both tiers with the forgotten entries
 *     counted as at risk — a forgotten entry IS a deletion),
 *   - the prefix is REQUIRED and validated below, so there is no form of this flag that forfeits
 *     the whole baseline in one keystroke.
 */

export type ForgetPrefixResult =
  | { readonly ok: true; readonly prefix: RepoRelativePath }
  | { readonly ok: false; readonly message: string };

/**
 * Normalizes and validates a user-supplied prefix. Rejects, rather than coerces, everything that
 * could mean more than the user typed:
 *
 *   - **empty / whitespace / `.` / `./`** — all normalize to the repository root, which is the bare
 *     "forget everything" form ADR 028 Stage 4 forbids. An empty value is not hypothetical: it is
 *     what `--forget-unscanned "$DIR"` produces when `DIR` is unset.
 *   - **absolute paths** — baseline entries are repo-relative, so an absolute prefix can only ever
 *     match by accident, and accepting it would suggest align understood a path it did not.
 *   - **any `..` segment** — a prefix that walks out of the repository is either a mistake or an
 *     attempt to address something align does not own. Checked per segment rather than on the
 *     leading characters, so `vendor/../..` is caught too.
 *
 * Returns the message rather than printing it, so the caller reports it through `reportCliError`
 * with the command name attached, like every other CLI refusal.
 */
export function parseForgetUnscannedPrefix(raw: string): ForgetPrefixResult {
  const normalized = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  const reject = (why: string): ForgetPrefixResult => ({
    ok: false,
    message:
      `--forget-unscanned requires an explicit repo-relative path prefix, and '${raw}' ${why}. ` +
      "Name the subtree whose retained entries you are forfeiting (for example: --forget-unscanned vendor). " +
      'There is deliberately no form of this flag that forfeits the whole baseline.',
  });
  if (normalized === '' || normalized === '.') return reject('resolves to the repository root');
  if (normalized.startsWith('/')) return reject('is an absolute path, but baseline entries are repo-relative');
  if (normalized.split('/').includes('..')) return reject('walks outside the repository');
  return { ok: true, prefix: toRepoRelativePath(normalized) };
}

export interface ForgetSplit<T> {
  /** Retained candidates at or under the prefix — the user has forfeited these; the caller must NOT
   * write them back, and must count them as at risk for ADR 023 tier 2. */
  readonly forgotten: readonly RetainedCandidate<T>[];
  /** Everything still retained — written back exactly as it would have been without the flag. */
  readonly retained: readonly RetainedCandidate<T>[];
}

/**
 * Splits an already-computed retention set by the prefix. Applied to `retained` ONLY, never to the
 * forfeited half: an entry the normal path already decided to delete needs no help from this flag,
 * and passing the whole candidate set through here would let a prefix silently change what "fixed"
 * means for entries retention never touched.
 *
 * Containment is `isUnderRepoPath` — core's single at-or-under test, shared with the blind-spot
 * matching this is undoing, so `--forget-unscanned vendor` covers exactly the files a `vendor` blind
 * spot covered. That also means `vendor` does not match `vendor-extra/x.ts`, which a naive
 * `startsWith` would.
 */
export function splitForgotten<T extends { readonly file: RepoRelativePath }>(
  retained: readonly RetainedCandidate<T>[],
  prefix: RepoRelativePath,
): ForgetSplit<T> {
  const forgotten: RetainedCandidate<T>[] = [];
  const kept: RetainedCandidate<T>[] = [];
  for (const item of retained) {
    (isUnderRepoPath(item.candidate.file, prefix) ? forgotten : kept).push(item);
  }
  return { forgotten, retained: kept };
}
