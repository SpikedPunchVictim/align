import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The CLI's telemetry surface is the one place file I/O actually happens for this feature (core's
 * copy of this test asserts the pure event/serializer/diff module; this asserts the imperative
 * shell that resolves flags and appends `.align/telemetry.jsonl`) — LOCAL FILE ONLY, NEVER a
 * network call, mirroring align's own untrusted-mode trust posture (ADR 001/014).
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

describe('CLI telemetry module: network abstinence', () => {
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

  it('also scans commands/check.ts, baseline.ts, build.ts, agent.ts, telemetry.ts and align-dir.ts (telemetry\'s call sites)', () => {
    const callSites = ['check.ts', 'baseline.ts', 'build.ts', 'agent.ts', 'telemetry.ts'].map((f) =>
      path.join(TELEMETRY_SRC_DIR, '..', 'commands', f),
    );
    callSites.push(path.join(TELEMETRY_SRC_DIR, '..', 'align-dir.ts'));
    for (const file of callSites) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    }
  });
});
