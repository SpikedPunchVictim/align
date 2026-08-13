/**
 * Shared detection logic for the interior `**` + `/` selector-drift shape (ADR 022; commit 6d6c9c1).
 * Both the validator (`validators/glob-double-star-drift.ts`) and the transform
 * (`transforms/glob-double-star-rewrite.ts`) must agree on EXACTLY which selectors are affected —
 * that is one fact, not two (CODING_BEST_PRACTICES.md §26, "DRY the things that must change
 * together") — so it lives here once and both consume it rather than each re-deriving its own
 * notion of "affected."
 */
import { globMatch } from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { loadConfig } from '../config.js';
import { legacyGlobMatch } from './legacy-glob.js';

/**
 * Rewrites a glob pattern so the CURRENT whole-segment `**` engine (`globToRegExp`,
 * `packages/core/src/components/glob.ts`) compiles it to the exact same regex the LEGACY
 * cross-segment engine (`legacy-glob.ts`) compiled the ORIGINAL pattern to.
 *
 * **Why this works, precisely.** The current engine's tokenizer treats a `**` occurrence as
 * "interior" — compiling it to a whole-segment-optional group — only when the character immediately following it is
 * `/`; otherwise (nothing follows, or the next character is anything else) it takes the exact same
 * "trailing" branch the LEGACY engine took for *every* `**` occurrence, interior or not: emit
 * `.*`. So deleting the `/` that immediately follows an interior `**` token forces the current
 * engine down its trailing branch for that occurrence — which emits byte-for-byte the same regex
 * fragment the legacy engine already emitted there (legacy also consumed that same `/` without
 * emitting anything for it). Do this for every interior `**` token and the two engines' output
 * regexes become identical, not merely equivalent.
 *
 * **Why this walks the pattern character-by-character instead of doing a blind
 * `pattern.split("**" + "/").join("**")`.** A naive substring replace mis-tokenizes adjacent-run
 * cases — e.g. the pattern `a/***` followed by `/b` contains that same three-character substring
 * (at the second and third `*` plus the `/`), but the REAL tokenizer (both legacy's and current's)
 * greedily consumes the FIRST two `*` as one `**` token, leaving the third `*` as an unrelated
 * single-star token immediately followed by a literal `/` — not an interior `**` token at all. A
 * blind replace would delete that `/` anyway and change
 * the pattern's meaning. Walking the pattern with the same greedy left-to-right rule the real
 * compiler uses (`normalized[i+1] === '*'` starts a token, `normalized[i+2]` decides interior vs.
 * trailing) makes this function agree with the compiler about where the tokens actually are.
 *
 * This function does not stop at trusting the proof above, though — see
 * `findAffectedGlobDoubleStarSelectors`'s `verifiedRewrite` field, which checks it empirically
 * against a repo's real scanned files before the transform ever treats it as safe to apply.
 */
export function rewriteInteriorDoubleStar(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // Interior token: drop the following `/` so the current engine's tokenizer takes its
        // TRAILING branch here instead of its interior one.
        out += '**';
        i += 3;
        continue;
      }
      out += '**';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

export interface AffectedGlobSelector {
  readonly component: string;
  readonly pattern: string;
  readonly lost: readonly string[];
  readonly gained: readonly string[];
  /** `pattern` rewritten by `rewriteInteriorDoubleStar` — the transform's candidate replacement. */
  readonly rewritten: string;
  /** Whether re-running BOTH engines against this repo's actual scanned files — legacy on
   * `pattern`, current on `rewritten` — produced EXACTLY the same file set. This is the
   * transform's real safety gate (ADR 022 criterion 2: "mechanical and unambiguous"); the
   * character-walking rewrite above is expected to satisfy it for every realistic pattern (see its
   * own doc comment), and this field is what lets the transform refuse instead of trusting that
   * proof blindly for a pattern shape it didn't anticipate. */
  readonly verifiedRewrite: boolean;
}

/**
 * Returns every glob-kind selector pattern (across every component) whose match set differs
 * between the legacy (pre-6d6c9c1) and current `**` engines, scanned against this repo's real
 * files. Returns `[]` — never throws — on a config-load or scan failure: those failures are
 * already reported by `align check`/`align doctor` themselves, and a caller duplicating that noise
 * would be a second, possibly-inconsistent report of the same problem.
 */
export async function findAffectedGlobDoubleStarSelectors(rootDir: string): Promise<readonly AffectedGlobSelector[]> {
  const loaded = await loadConfig(rootDir).catch(() => undefined);
  if (loaded === undefined) return [];

  const plugin = new TypeScriptPlugin();
  const graph = await plugin.scanner
    .scan({
      rootDir,
      components: loaded.ruleset.components,
      excludes: loaded.excludes,
      includeNestedCheckouts: loaded.includeNestedCheckouts,
    })
    .catch(() => undefined);
  if (graph === undefined) return [];

  const allFiles = graph.nodes.map((node) => node.file);
  const affected: AffectedGlobSelector[] = [];

  for (const [name, def] of Object.entries(loaded.ruleset.components)) {
    if (def.selector.kind !== 'glob') continue;
    for (const pattern of def.selector.patterns) {
      if (!pattern.includes('**/')) continue; // trailing `**` is unaffected — nothing to compare

      const oldMatches = new Set(allFiles.filter((file) => legacyGlobMatch(pattern, file)));
      const newMatches = new Set(allFiles.filter((file) => globMatch(pattern, file)));
      const lost = [...oldMatches].filter((file) => !newMatches.has(file)).sort();
      const gained = [...newMatches].filter((file) => !oldMatches.has(file)).sort();
      if (lost.length === 0 && gained.length === 0) continue;

      const rewritten = rewriteInteriorDoubleStar(pattern);
      const verifyMatches = new Set(allFiles.filter((file) => globMatch(rewritten, file)));
      affected.push({ component: name, pattern, lost, gained, rewritten, verifiedRewrite: setsEqual(oldMatches, verifyMatches) });
    }
  }
  return affected;
}
