import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/build/sections.js';

describe('parseMarkdownDoc', () => {
  it('splits a doc into heading-anchored sections', () => {
    const doc = ['# Title', '', 'Intro text.', '', '## Section One', '', 'Body one.', '', '## Section Two', '', 'Body two.'].join('\n');
    const { sections } = parseMarkdownDoc(doc);
    expect(sections.map((s) => s.headingText)).toEqual(['Title', 'Section One', 'Section Two']);
    expect(sections[1]?.bodyText).toContain('Body one.');
    expect(sections[2]?.bodyText).toContain('Body two.');
  });

  it('dedupes identical heading slugs', () => {
    const doc = ['## Rules', 'a', '## Rules', 'b'].join('\n');
    const { sections } = parseMarkdownDoc(doc);
    expect(sections.map((s) => s.anchor)).toEqual(['rules', 'rules-2']);
  });

  it('content hash changes iff the section text changes, independent of other sections', () => {
    const a = ['## One', 'body a', '## Two', 'body b'].join('\n');
    const b = ['## One', 'body a', '## Two', 'body b changed'].join('\n');
    const secA = parseMarkdownDoc(a).sections;
    const secB = parseMarkdownDoc(b).sections;
    expect(secA[0]?.contentHash).toBe(secB[0]?.contentHash); // untouched section
    expect(secA[1]?.contentHash).not.toBe(secB[1]?.contentHash); // reworded section
  });

  it('a section with no body is classified with empty bodyText', () => {
    const doc = ['## Empty', '## Next', 'text'].join('\n');
    const { sections } = parseMarkdownDoc(doc);
    expect(sections[0]?.bodyText.trim()).toBe('');
  });
});
