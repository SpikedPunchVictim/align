import { describe, expect, it } from 'vitest';
import { locateBlock, spliceOrAppendBlock } from '../../src/init/marker-block.js';

const START = '<<START>>';
const END = '<<END>>';
const FILE = '/repo/FIXTURE.md';

describe('locateBlock', () => {
  it('returns undefined when neither marker is present (state 1/2: nothing to splice — append)', () => {
    expect(locateBlock('no markers here', FILE, START, END)).toBeUndefined();
    expect(locateBlock('', FILE, START, END)).toBeUndefined();
  });

  it('returns the splice bounds for exactly one well-formed pair (state 3)', () => {
    const existing = `before\n${START}\nbody\n${END}\nafter`;
    const located = locateBlock(existing, FILE, START, END);
    expect(located).toBeDefined();
    expect(existing.slice(located!.start, located!.start + START.length)).toBe(START);
    expect(existing.slice(located!.end, located!.end + END.length)).toBe(END);
  });

  it('throws on START only, no END (state 4)', () => {
    expect(() => locateBlock(`x\n${START}\ny`, FILE, START, END)).toThrow(/malformed align block/);
  });

  it('throws on END only, no START (state 5)', () => {
    expect(() => locateBlock(`x\n${END}\ny`, FILE, START, END)).toThrow(/malformed align block/);
  });

  it('throws on END before START (state 6)', () => {
    expect(() => locateBlock(`${END}\nmiddle\n${START}`, FILE, START, END)).toThrow(/malformed align block/);
  });

  it('throws on two complete pairs (state 7)', () => {
    expect(() => locateBlock(`${START}\na\n${END}\n\n${START}\nb\n${END}`, FILE, START, END)).toThrow(/malformed align block/);
  });

  it('error message names the file, the markers, and the observed counts', () => {
    try {
      locateBlock(`${START}\nonly a start`, FILE, START, END);
      throw new Error('expected locateBlock to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain(FILE);
      expect(message).toContain(START);
      expect(message).toContain(END);
      expect(message).toContain('1');
      expect(message).toContain('0');
    }
  });

  it('boundary arithmetic: occurrence counting is correct at 0, 1, and 2 across both markers independently', () => {
    // Two starts, zero ends — an orphan-heavy variant of state 7's sibling shape.
    expect(() => locateBlock(`${START}\n${START}`, FILE, START, END)).toThrow(/2 `<<START>>` and 0 `<<END>>`/);
    // Zero starts, two ends.
    expect(() => locateBlock(`${END}\n${END}`, FILE, START, END)).toThrow(/0 `<<START>>` and 2 `<<END>>`/);
  });
});

describe('spliceOrAppendBlock', () => {
  it('appends with a blank-line separator when the file has no trailing newline', () => {
    const result = spliceOrAppendBlock('human content, no newline', 'NEWBLOCK', FILE, START, END);
    expect(result).toBe('human content, no newline\n\nNEWBLOCK\n');
  });

  it('appends with a single-newline separator when the file already ends in a newline', () => {
    const result = spliceOrAppendBlock('human content\n', 'NEWBLOCK', FILE, START, END);
    expect(result).toBe('human content\n\nNEWBLOCK\n');
  });

  it('splices the new block between an existing well-formed pair, preserving surrounding content', () => {
    const existing = `# Before\n\n${START}\nstale\n${END}\n\n# After\n`;
    const result = spliceOrAppendBlock(existing, `${START}\nfresh\n${END}`, FILE, START, END);
    expect(result).toBe(`# Before\n\n${START}\nfresh\n${END}\n\n# After\n`);
  });

  it('splicing twice in a row is idempotent', () => {
    const existing = `# Before\n\n${START}\nstale\n${END}\n\n# After\n`;
    const newBlock = `${START}\nfresh\n${END}`;
    const once = spliceOrAppendBlock(existing, newBlock, FILE, START, END);
    const twice = spliceOrAppendBlock(once, newBlock, FILE, START, END);
    expect(twice).toBe(once);
  });

  it('throws instead of splicing on every malformed arrangement (states 4-7), never touching the split result', () => {
    const newBlock = `${START}\nfresh\n${END}`;
    expect(() => spliceOrAppendBlock(`${START}\nonly start`, newBlock, FILE, START, END)).toThrow(/malformed align block/);
    expect(() => spliceOrAppendBlock(`${END}\nonly end`, newBlock, FILE, START, END)).toThrow(/malformed align block/);
    expect(() => spliceOrAppendBlock(`${END}\nmid\n${START}`, newBlock, FILE, START, END)).toThrow(/malformed align block/);
    expect(() => spliceOrAppendBlock(`${START}\na\n${END}\n${START}\nb\n${END}`, newBlock, FILE, START, END)).toThrow(
      /malformed align block/,
    );
  });
});
