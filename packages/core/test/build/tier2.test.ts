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

  it('parses a source-hygiene sentence (security.manifest.source-hygiene, ADR 013)', () => {
    expect(parseBulletSentence('Dependencies must be sourced from the registry.')).toEqual({
      kind: 'security.manifest.source-hygiene',
    });
  });

  it('parses a shorter source-hygiene phrasing', () => {
    expect(parseBulletSentence('Dependency must be registry.')).toEqual({
      kind: 'security.manifest.source-hygiene',
    });
  });

  it('parses a new-dependency-gate sentence (security.manifest.new-dependency, ADR 013)', () => {
    expect(parseBulletSentence('New dependencies require baseline approval.')).toEqual({
      kind: 'security.manifest.new-dependency',
    });
  });

  it('parses a new-dependency-gate sentence with "needs ... acceptance"', () => {
    expect(parseBulletSentence('New dependency needs baseline acceptance')).toEqual({
      kind: 'security.manifest.new-dependency',
    });
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

  // R5 (precision-ladder gap, GREENFIELD_TRIAD_REPORT.md §1): a trailing "Because <rationale>."
  // clause parses into the fragment's `because` field — previously only fenced ```align blocks
  // (tier 1) could carry an authored rationale; tier-2 bullets had no field for it at all.
  describe('trailing "Because ..." rationale clause (R5)', () => {
    it('parses the doc\'s own worked example into a fragment with `because` set', () => {
      const doc = [
        '## API layering',
        '',
        '- **Rule**: api may only depend on core. Because the API layer must stay headless.',
        '',
      ].join('\n');
      const { sections } = parseMarkdownDoc(doc);
      const section = sections[0];
      if (section === undefined) throw new Error('unreachable');
      const { bullets, errors } = extractStructuredBullets(doc.split('\n'), section, docPath);
      expect(errors).toHaveLength(0);
      expect(bullets).toHaveLength(1);
      expect(bullets[0]?.fragment).toEqual({
        kind: 'arch.layers',
        layers: [{ layer: 'api', canDependOn: ['core'] }],
        because: 'the API layer must stay headless',
      });
    });

    it('a bullet with no "Because" clause parses with `because` left unset (unchanged behavior)', () => {
      const doc = ['## Constraints', '', '- **Rule**: api must not depend on ui.', ''].join('\n');
      const { sections } = parseMarkdownDoc(doc);
      const section = sections[0];
      if (section === undefined) throw new Error('unreachable');
      const { bullets } = extractStructuredBullets(doc.split('\n'), section, docPath);
      expect(bullets[0]?.fragment).toEqual({ kind: 'arch.no-dependency', from: 'api', to: 'ui' });
    });

    it('works for a bare no-cycles bullet too (rationale is orthogonal to which rule kind matched)', () => {
      const doc = ['## Constraints', '', '- **Rule**: no cycles. Because circular imports hide real dependency direction.', ''].join('\n');
      const { sections } = parseMarkdownDoc(doc);
      const section = sections[0];
      if (section === undefined) throw new Error('unreachable');
      const { bullets, errors } = extractStructuredBullets(doc.split('\n'), section, docPath);
      expect(errors).toHaveLength(0);
      expect(bullets[0]?.fragment).toEqual({
        kind: 'arch.no-cycles',
        scope: 'repo',
        because: 'circular imports hide real dependency direction',
      });
    });

    it('a bare mid-sentence "because" without the period boundary is left unsplit (deterministic — no NLP)', () => {
      // No sentence-ending period before "Because", so this doesn't match the grammar at all —
      // the whole thing is passed to parseBulletSentence as one string, which rejects it. This is
      // the deliberate boundary condition: the separator is mechanical, not semantic.
      const doc = ['## Constraints', '', '- **Rule**: the system should be modular because it helps.', ''].join('\n');
      const { sections } = parseMarkdownDoc(doc);
      const section = sections[0];
      if (section === undefined) throw new Error('unreachable');
      const { bullets, errors } = extractStructuredBullets(doc.split('\n'), section, docPath);
      expect(bullets).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.reason).toBe('unparsed-bullet');
    });
  });
});
