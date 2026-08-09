/**
 * Pre-0.2.0 `**` semantics, reconstructed verbatim from `packages/core/src/components/glob.ts` as
 * it stood before commit 6d6c9c1 ("make `**` whole-segment and drop the duplicate glob matcher").
 * Exists ONLY so the `glob-double-star-selector-drift` migration validator can compute a real
 * before/after comparison against a repo's actual selectors and files (ADR 022: "align can compute
 * both semantics, so this is a real detection, not a guess") — this is not a general-purpose
 * matcher and must never be used for anything except that one comparison. Core does not carry this
 * itself: the old behavior was a bug, not a supported dialect, and core has no reason to remember
 * it once the fix landed.
 *
 * Brace expansion (`expandBraces`) is unchanged by 6d6c9c1 — reused from core rather than
 * duplicated, same as `globMatch` itself for the "new" side of the comparison.
 */
import { expandBraces } from '@spikedpunch/align-core';

function legacyGlobToRegExp(pattern: string): RegExp {
  const normalized = pattern.split('\\').join('/');
  let out = '';
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        // Pre-fix behavior: EVERY `**` — interior or trailing — compiled to `.*` (crossing `/`)
        // and consumed one following `/` if present. This is what let `app/**/model.ts` match
        // `app/datamodel.ts` (the bug commit 6d6c9c1's message cites verbatim).
        let j = i + 2;
        if (normalized[j] === '/') j += 1;
        out += '.*';
        i = j;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c !== undefined && '.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

export function legacyGlobMatch(pattern: string, filePath: string): boolean {
  return expandBraces(pattern).some((expanded) => legacyGlobToRegExp(expanded).test(filePath));
}
