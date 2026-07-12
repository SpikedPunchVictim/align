import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/build/sections.js';
import { extractFencedAlignBlocks } from '../../src/build/tier1.js';
import { toRepoRelativePath } from '../../src/types/branded.js';

const docPath = toRepoRelativePath('docs/ARCHITECTURE-RULES.md');

describe('extractFencedAlignBlocks', () => {
  it('parses a valid ```align block into a RuleFragment', () => {
    const doc = ['## Isolation', '', '```align', '{"kind":"arch.no-dependency","from":"core","to":"cli"}', '```', ''].join('\n');
    const { sections } = parseMarkdownDoc(doc);
    const section = sections[0];
    if (section === undefined) throw new Error('unreachable');
    const { fragments, errors } = extractFencedAlignBlocks(doc.split('\n'), section, docPath);
    expect(errors).toHaveLength(0);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.fragment).toEqual({ kind: 'arch.no-dependency', from: 'core', to: 'cli' });
    expect(fragments[0]?.sourceQuote).toContain('"kind":"arch.no-dependency"');
  });

  it('flags invalid JSON as invalid-fragment, never throwing', () => {
    const doc = ['## Isolation', '', '```align', '{not valid json', '```', ''].join('\n');
    const { sections } = parseMarkdownDoc(doc);
    const section = sections[0];
    if (section === undefined) throw new Error('unreachable');
    const { fragments, errors } = extractFencedAlignBlocks(doc.split('\n'), section, docPath);
    expect(fragments).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('invalid-fragment');
  });

  it('flags a well-formed JSON object that fails schema validation', () => {
    const doc = ['## Isolation', '', '```align', '{"kind":"not-a-real-kind"}', '```', ''].join('\n');
    const { sections } = parseMarkdownDoc(doc);
    const section = sections[0];
    if (section === undefined) throw new Error('unreachable');
    const { fragments, errors } = extractFencedAlignBlocks(doc.split('\n'), section, docPath);
    expect(fragments).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('invalid-fragment');
  });

  it('ignores fences outside the align language tag', () => {
    const doc = ['## Isolation', '', '```json', '{"kind":"arch.no-dependency","from":"core","to":"cli"}', '```', ''].join('\n');
    const { sections } = parseMarkdownDoc(doc);
    const section = sections[0];
    if (section === undefined) throw new Error('unreachable');
    const { fragments, errors } = extractFencedAlignBlocks(doc.split('\n'), section, docPath);
    expect(fragments).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
