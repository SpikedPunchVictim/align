/**
 * Minimal dependency-free glob matcher for component file selectors (ADR 003). align/core's
 * only runtime dependency is zod, so this is a small hand-rolled glob-to-regex compiler rather
 * than pulling in micromatch/minimatch — it only needs to support the pattern vocabulary
 * component selectors actually use: `*` (one path segment), `**` (zero or more segments), `?`
 * (one character), and literal path segments.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.split('\\').join('/');
  let out = '';
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        // `**` — consume any following `/` so `a/**/b` and `a/**` both behave sanely.
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

const regexCache = new Map<string, RegExp>();
const expansionCache = new Map<string, readonly string[]>();

/**
 * Expands flat, single-level brace groups before compilation: `llm-{anthropic,ollama}/**` ->
 * [`llm-anthropic/**`, `llm-ollama/**`]. Multiple sibling groups expand as a cartesian product
 * (`{a,b}/{c,d}` -> `a/c`, `a/d`, `b/c`, `b/d`). NESTED braces and ranges (`{a..z}`) are out of
 * scope and rejected up front by `lintGlobPattern` at config load; on malformed input this returns
 * the pattern unchanged so it merely fails to match rather than throwing on the scan hot path.
 */
export function expandBraces(pattern: string): readonly string[] {
  const cached = expansionCache.get(pattern);
  if (cached !== undefined) return cached;
  const result = expandBracesUncached(pattern);
  expansionCache.set(pattern, result);
  return result;
}

function expandBracesUncached(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) return [pattern]; // unmatched — lint rejects; fall back to a literal match
  const before = pattern.slice(0, open);
  const alternatives = pattern.slice(open + 1, close).split(',');
  const expandedTails = expandBracesUncached(pattern.slice(close + 1));
  const out: string[] = [];
  for (const alt of alternatives) {
    for (const tail of expandedTails) out.push(before + alt + tail);
  }
  return out;
}

const UNSUPPORTED_METACHARS: ReadonlyArray<readonly [char: string, label: string]> = [
  ['[', 'character classes (`[...]`)'],
  [']', 'character classes (`[...]`)'],
  ['(', 'extglob groups (`(...)`)'],
  [')', 'extglob groups (`(...)`)'],
  ['|', 'alternation (`|`)'],
];

/**
 * Lints a selector against align's minimal glob dialect (`*`, `**`, `?`, `{a,b,c}` brace expansion,
 * literals). Returns a short description of the FIRST unsupported construct, or undefined when the
 * pattern is valid. This is what keeps the deliberately-minimal dialect *loudly* minimal: unsupported
 * syntax (character classes, extglobs, negation, nested/range braces) fails at config load with a
 * precise message instead of silently compiling to a literal that matches zero files.
 */
export function lintGlobPattern(pattern: string): string | undefined {
  if (pattern.startsWith('!')) return 'negated patterns (leading `!`)';
  let depth = 0;
  let group = '';
  for (const ch of pattern) {
    if (ch === '{') {
      if (depth > 0) return 'nested brace groups (`{..{..}..}`)';
      depth += 1;
      group = '';
      continue;
    }
    if (ch === '}') {
      if (depth === 0) return 'an unmatched `}`';
      depth -= 1;
      if (group.includes('..')) return 'brace ranges (`{a..z}`)';
      continue;
    }
    if (depth > 0) group += ch;
  }
  if (depth !== 0) return 'an unmatched `{`';
  for (const [char, label] of UNSUPPORTED_METACHARS) {
    if (pattern.includes(char)) return label;
  }
  return undefined;
}

export function globMatch(pattern: string, filePath: string): boolean {
  return expandBraces(pattern).some((expanded) => {
    let re = regexCache.get(expanded);
    if (re === undefined) {
      re = globToRegExp(expanded);
      regexCache.set(expanded, re);
    }
    return re.test(filePath);
  });
}
