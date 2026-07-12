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

export function globMatch(pattern: string, filePath: string): boolean {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    re = globToRegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re.test(filePath);
}
