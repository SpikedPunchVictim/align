import { describe, expect, it } from 'vitest';
import { parseBulletSentence, extractStructuredBullets } from '../../src/build/tier2.js';
import { parseMarkdownDoc } from '../../src/build/sections.js';
import { toRepoRelativePath } from '../../src/types/branded.js';

const docPath = toRepoRelativePath('docs/ARCHITECTURE-RULES.md');

describe('parseBulletSentence', () => {
  it('parses a no-dependency sentence', () => {
    expect(parseBulletSentence('`core` must not depend on `cli`')).toEqual({
      kind: 'arch.no-dependency',
      from: '`core`',
      to: '`cli`',
    });
  });

  it('parses a bare no-cycles sentence as repo scope', () => {
    expect(parseBulletSentence('No cycles.')).toEqual({ kind: 'arch.no-cycles', scope: 'repo' });
  });

  it('parses a scoped no-cycles sentence', () => {
    expect(parseBulletSentence('No cycles within `core`')).toEqual({ kind: 'arch.no-cycles', scope: '`core`' });
  });

  it('parses a subject-first no-cycles sentence', () => {
    expect(parseBulletSentence('`core` must have no cycles')).toEqual({ kind: 'arch.no-cycles', scope: '`core`' });
  });

  it('parses a layers ("may only depend on") sentence', () => {
    expect(parseBulletSentence('`pluginTypescript` may only depend on `core`')).toEqual({
      kind: 'arch.layers',
      layers: [{ layer: '`pluginTypescript`', canDependOn: ['`core`'] }],
    });
  });

  it('parses a multi-target layers sentence', () => {
    expect(parseBulletSentence('`cli` can only depend on `core` and `pluginTypescript`')).toEqual({
      kind: 'arch.layers',
      layers: [{ layer: '`cli`', canDependOn: ['`core`', '`pluginTypescript`'] }],
    });
  });

  it('parses a max-LOC ("must stay under N lines") sentence (arch.metric, loc-only)', () => {
    expect(parseBulletSentence('Files in `api` must stay under 800 lines')).toEqual({
      kind: 'arch.metric',
      target: '`api`',
      metric: 'loc',
      max: 800,
    });
  });

  it('parses a max-LOC sentence with the trailing period and singular "line" tolerated', () => {
    expect(parseBulletSentence('files in api must stay under 1 line.')).toEqual({
      kind: 'arch.metric',
      target: 'api',
      metric: 'loc',
      max: 1,
    });
  });

  it('returns undefined for an unsupported multi-target max-LOC sentence', () => {
    expect(parseBulletSentence('Files in `api` and `ui` must stay under 800 lines')).toBeUndefined();
  });

  it('returns undefined for a sentence outside the grammar', () => {
    expect(parseBulletSentence('the system should be modular')).toBeUndefined();
  });

  it('returns undefined for an unsupported multi-target no-dependency sentence', () => {
    expect(parseBulletSentence('`core` must not depend on `cli` or `pluginTypescript`')).toBeUndefined();
  });
});

describe('extractStructuredBullets', () => {
  it('extracts one bullet per matching line and flags unparsed ones', () => {
    const doc = [
      '## Constraints',
      '',
      '- **Rule**: `core` must not depend on `cli`.',
      '- Not a rule bullet, ignored.',
      '- **Rule**: the system should be modular.',
      '',
    ].join('\n');
    const { sections } = parseMarkdownDoc(doc);
    const section = sections[0];
    if (section === undefined) throw new Error('unreachable');
    const { bullets, errors } = extractStructuredBullets(doc.split('\n'), section, docPath);
    expect(bullets).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('unparsed-bullet');
  });
});
