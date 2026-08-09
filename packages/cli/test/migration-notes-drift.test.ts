import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@spikedpunch/align-core';
import { describe, expect, it } from 'vitest';
import { compileUpgradingNotes } from '../src/migrations/notes-compiler.js';
import { COMPILED_NOTES, UPGRADING_MD_CONTENT_HASH } from '../src/migrations/notes.generated.js';

// ADR 011's drift-detection discipline (`rules.lock.json`'s `docContentHash` vs the doc's actual
// current hash), applied to UPGRADING.md -> notes.generated.ts. A generated artifact that silently
// goes stale is a false green: `align upgrade` would confidently print notes that no longer match
// what shipped. `notes.generated.ts` embeds the content hash it was compiled from; this test
// recomputes UPGRADING.md's ACTUAL current hash with the same `sha256Hex` utility
// (`hash.ts` — no second hashing scheme) and fails if they disagree.

const here = path.dirname(fileURLToPath(import.meta.url));
const upgradingMdPath = path.join(here, '..', '..', '..', 'UPGRADING.md');

function readUpgradingMd(): string {
  return fs.readFileSync(upgradingMdPath, 'utf8');
}

describe('UPGRADING.md -> notes.generated.ts drift (ADR 011 applied to ADR 022 notes)', () => {
  it('UPGRADING.md exists at the expected repo-root path', () => {
    expect(fs.existsSync(upgradingMdPath)).toBe(true);
  });

  it('notes.generated.ts was compiled from UPGRADING.md as it stands right now — the hashes match', () => {
    const docText = readUpgradingMd();
    expect(sha256Hex(docText)).toBe(UPGRADING_MD_CONTENT_HASH);
  });

  it('re-compiling UPGRADING.md right now reproduces exactly what is checked into notes.generated.ts', () => {
    const docText = readUpgradingMd();
    const recompiled = compileUpgradingNotes(docText);
    expect(recompiled.contentHash).toBe(UPGRADING_MD_CONTENT_HASH);
    expect(recompiled.notesByVersion).toEqual(COMPILED_NOTES);
  });

  it('demonstrates the failure this guards against: an edit to the doc that is never recompiled changes the hash away from what notes.generated.ts has checked in', () => {
    const docText = readUpgradingMd();
    // Simulates exactly the scenario the task asks to demonstrate — someone edits UPGRADING.md and
    // forgets to re-run `node packages/cli/scripts/compile-upgrading-notes.mjs`. We do this
    // in-memory rather than mutating the real file on disk (which would make this test's outcome
    // depend on execution order with the other tests in this file / leave the repo dirty), but the
    // assertion is the same one that fires for real: the doc's current hash no longer matches the
    // hash `notes.generated.ts` was compiled from.
    const editedWithoutRecompiling = `${docText}\n\n### A note someone added by hand, without recompiling\n\nThis text exists only in the doc now.\n`;
    expect(sha256Hex(editedWithoutRecompiling)).not.toBe(UPGRADING_MD_CONTENT_HASH);
    // ...and this is exactly the comparison `migration-registry-completeness`-adjacent tooling (or
    // a future `align doctor` advisory) would use to detect it: recompiling the edited text yields
    // a different hash and different notes than what shipped.
    const recompiledEdited = compileUpgradingNotes(editedWithoutRecompiling);
    expect(recompiledEdited.contentHash).not.toBe(UPGRADING_MD_CONTENT_HASH);
    expect(recompiledEdited.notesByVersion).not.toEqual(COMPILED_NOTES);
  });
});
