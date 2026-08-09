import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@spikedpunch/align-core';
import { compileUpgradingNotes } from '../src/migrations/notes-compiler.js';

// ADR 022's notes tier + ADR 011's doc-is-source pattern: `compileUpgradingNotes` turns a
// version-keyed markdown doc into per-version `MigrationNote`s. Exercised entirely against
// synthetic doc strings — the real UPGRADING.md is covered separately by
// `migration-notes-drift.test.ts` (does the checked-in generated file match it right now) and
// `migration-registry-completeness.test.ts` (does the current version's entry have notes).

describe('compileUpgradingNotes', () => {
  it('parses a version-keyed doc into the expected per-version notes', () => {
    const doc = [
      '# Upgrading align',
      '',
      'Intro prose, ignored — not a version or note section.',
      '',
      '## 0.1.4',
      '',
      '### First change',
      '',
      'Body of the first change.',
      '',
      '### Second change',
      '',
      'Body of the second change.',
      'Second line of the same note.',
      '',
    ].join('\n');

    const { notesByVersion } = compileUpgradingNotes(doc);

    expect(Object.keys(notesByVersion)).toEqual(['0.1.4']);
    expect(notesByVersion['0.1.4']).toEqual([
      { heading: 'First change', body: 'Body of the first change.' },
      { heading: 'Second change', body: 'Body of the second change.\nSecond line of the same note.' },
    ]);
  });

  it('splits notes correctly across multiple version sections', () => {
    const doc = ['## 0.1.4', '', '### A', '', 'a body', '', '## 0.2.0', '', '### B', '', 'b body', ''].join('\n');

    const { notesByVersion } = compileUpgradingNotes(doc);

    expect(Object.keys(notesByVersion)).toEqual(['0.1.4', '0.2.0']);
    expect(notesByVersion['0.1.4']).toEqual([{ heading: 'A', body: 'a body' }]);
    expect(notesByVersion['0.2.0']).toEqual([{ heading: 'B', body: 'b body' }]);
  });

  it('a version section with zero notes compiles to an empty array — a structural parse, not an error (content completeness is a separate check)', () => {
    const doc = ['## 0.1.4', '', 'Just prose, no ### notes here.', ''].join('\n');
    const { notesByVersion } = compileUpgradingNotes(doc);
    expect(notesByVersion['0.1.4']).toEqual([]);
  });

  it('the content hash is sha256Hex of the exact doc text — reuses the existing hashing utility, not a second one', () => {
    const doc = '## 0.1.4\n\n### A\n\nbody\n';
    const { contentHash } = compileUpgradingNotes(doc);
    expect(contentHash).toBe(sha256Hex(doc));
  });

  it('throws loudly on a misnamed version heading (not a bare semver) rather than silently skipping it', () => {
    const doc = ['## Unreleased', '', '### A', '', 'body', ''].join('\n');
    expect(() => compileUpgradingNotes(doc)).toThrow(/not a version heading/);
  });

  it('throws loudly on a version heading with trailing text', () => {
    const doc = ['## 0.1.4 (unreleased)', '', '### A', '', 'body', ''].join('\n');
    expect(() => compileUpgradingNotes(doc)).toThrow(/not a version heading/);
  });

  it('throws loudly on a duplicate version section', () => {
    const doc = ['## 0.1.4', '', '### A', '', 'a', '', '## 0.1.4', '', '### B', '', 'b', ''].join('\n');
    expect(() => compileUpgradingNotes(doc)).toThrow(/duplicate version section/);
  });

  it('throws loudly on a "###" heading that is not inside any version section', () => {
    const doc = ['### Orphan note', '', 'body', '', '## 0.1.4', '', '### A', '', 'a', ''].join('\n');
    expect(() => compileUpgradingNotes(doc)).toThrow(/not inside any "##" version section/);
  });

  it('throws loudly on nesting deeper than "###"', () => {
    const doc = ['## 0.1.4', '', '### A', '', '#### Too deep', '', 'body', ''].join('\n');
    expect(() => compileUpgradingNotes(doc)).toThrow(/nested deeper than this compiler supports/);
  });

  it('an empty doc compiles to no versions and no notes, without throwing', () => {
    const { notesByVersion } = compileUpgradingNotes('');
    expect(notesByVersion).toEqual({});
  });
});
