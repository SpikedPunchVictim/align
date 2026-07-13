import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * align's own ethos (ADR 001, ADR 014's untrusted-mode trust posture): telemetry is a LOCAL FILE
 * ONLY, NEVER a network call. This asserts the source text of every file under
 * `packages/core/src/telemetry` never references a network primitive — the same trust posture
 * `docs/adr/014-untrusted-config-execution.md` already holds align's own config-execution surface
 * to, applied to the one new surface this feature adds. `packages/cli/src/telemetry` has its own
 * copy of this test (the CLI is where file I/O — and therefore any hypothetical network call —
 * would actually happen).
 */
const TELEMETRY_SRC_DIR = path.join(__dirname, '..', '..', 'src', 'telemetry');

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\baxios\b/,
  /from\s+['"]node:https?['"]/,
  /from\s+['"]https?['"]/,
  /require\(\s*['"]https?['"]\s*\)/,
  /from\s+['"]node:net['"]/,
  /require\(\s*['"]net['"]\s*\)/,
  /from\s+['"]node:tls['"]/,
  /require\(\s*['"]tls['"]\s*\)/,
  /from\s+['"]node:dgram['"]/,
  /require\(\s*['"]dgram['"]\s*\)/,
  // Matches an actual import/require of the Anthropic SDK, not prose mentioning its name in a
  // comment (the only real network-capable dependency anywhere in this monorepo, `agent`
  // package's `anthropicFixProvider.ts` — telemetry must never import it).
  /from\s+['"]@anthropic-ai\/sdk['"]/,
  /require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/,
];

function tsFilesUnder(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('telemetry module: network abstinence', () => {
  const files = tsFilesUnder(TELEMETRY_SRC_DIR);

  it('found at least one telemetry source file to scan (sanity check the assertion isn\'t vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${path.relative(TELEMETRY_SRC_DIR, file)} imports/uses no network primitive`, () => {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});
