import { describe, expect, it } from 'vitest';
import { wrapMessage } from '../src/commands/check.js';

describe('wrapMessage — human-readable check output', () => {
  it('wraps long prose so no line exceeds the width, never splitting a word', () => {
    const text =
      'application/api/package.json declares dependency undici via 7.25.0, not yet accepted into the baseline, which rule security.manifest.new-dependency flags.';
    const lines = wrapMessage(text, 6);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith('      ')).toBe(true); // 6-space indent
      expect(line.length).toBeLessThanOrEqual(120); // within the clamp ceiling
    }
    // round-trips: joining the trimmed words back reproduces the input (no word lost or split)
    expect(lines.map((l) => l.trim()).join(' ')).toBe(text);
  });

  it('applies the requested indent to every line', () => {
    const lines = wrapMessage('one two three', 2);
    for (const line of lines) expect(line.startsWith('  ')).toBe(true);
  });

  it('returns a single indented line for short text', () => {
    expect(wrapMessage('short', 4)).toEqual(['    short']);
  });

  it('collapses arbitrary whitespace to single spaces', () => {
    expect(wrapMessage('a\n\tb   c', 0)).toEqual(['a b c']);
  });
});
