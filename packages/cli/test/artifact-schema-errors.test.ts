import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generatedRulesPath,
  readBaseline,
  readGeneratedRules,
  readRulesetIr,
  rulesetIrPath,
} from '../src/align-dir.js';

// Bug hunt 2026-08-03 (noted alongside BUG #14, "one related defect noted, deliberately not
// folded in"): all three `.align/` artifact readers (`readBaseline`, `readGeneratedRules`,
// `readRulesetIr`) already turn a JSON.parse failure into align-authored prose naming the file,
// but a file that IS valid JSON and fails zod schema validation used to throw the raw `ZodError`
// straight through — an issue array with no file name and no framing, inconsistent with the
// JSON.parse catch two lines above it at every one of these sites. These tests assert the fix: a
// schema-invalid artifact now throws a readable message naming the file, while JSON-invalid and
// missing-file behavior are both unchanged.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-artifact-schema-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAlignFile(rootDir: string, filename: string, contents: string): void {
  fs.mkdirSync(path.join(rootDir, '.align'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.align', filename), contents, 'utf8');
}

/** A raw zod dump looks like `[ { "code": "invalid_type", "path": [...], "message": ... } ]` or
 * mentions "ZodError" — neither should ever reach a thrown error's `.message` after this fix. */
function looksLikeRawZodDump(message: string): boolean {
  return /ZodError/.test(message) || /"code":\s*"invalid_type"/.test(message) || /"expected":/.test(message);
}

describe('BUG #16 — schema-invalid .align/ artifacts throw readable prose, not a raw ZodError', () => {
  describe('readBaseline', () => {
    it('schema-invalid-but-JSON-valid: names the file and is not a raw zod dump', () => {
      tmpDir = copyFixture('simple-app');
      // Valid JSON, valid array, but entries are missing every required field.
      writeAlignFile(tmpDir, 'baseline.json', JSON.stringify([{ notAField: true }]));
      let thrown: unknown;
      try {
        readBaseline(tmpDir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(path.join(tmpDir, '.align', 'baseline.json'));
      expect(looksLikeRawZodDump(message)).toBe(false);
    });

    it('JSON-invalid: unchanged existing message', () => {
      tmpDir = copyFixture('simple-app');
      writeAlignFile(tmpDir, 'baseline.json', '{ not valid json');
      expect(() => readBaseline(tmpDir)).toThrow(/is not valid JSON/);
    });

    it('missing file: unchanged behavior (returns [])', () => {
      tmpDir = copyFixture('simple-app');
      expect(readBaseline(tmpDir)).toEqual([]);
    });
  });

  describe('readGeneratedRules', () => {
    it('schema-invalid-but-JSON-valid: names the file and is not a raw zod dump', () => {
      tmpDir = copyFixture('simple-app');
      writeAlignFile(tmpDir, 'generated-rules.json', JSON.stringify({ wrong: 'shape' }));
      let thrown: unknown;
      try {
        readGeneratedRules(tmpDir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(generatedRulesPath(tmpDir));
      expect(looksLikeRawZodDump(message)).toBe(false);
    });

    it('JSON-invalid: unchanged existing message', () => {
      tmpDir = copyFixture('simple-app');
      writeAlignFile(tmpDir, 'generated-rules.json', '{ not valid json');
      expect(() => readGeneratedRules(tmpDir)).toThrow(/is not valid JSON/);
    });

    it('missing file: unchanged behavior (returns undefined)', () => {
      tmpDir = copyFixture('simple-app');
      expect(readGeneratedRules(tmpDir)).toBeUndefined();
    });
  });

  describe('readRulesetIr', () => {
    it('schema-invalid-but-JSON-valid: names the file and is not a raw zod dump', () => {
      tmpDir = copyFixture('simple-app');
      writeAlignFile(tmpDir, 'ruleset-ir.json', JSON.stringify({ irVersion: '1' }));
      let thrown: unknown;
      try {
        readRulesetIr(tmpDir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(rulesetIrPath(tmpDir));
      expect(looksLikeRawZodDump(message)).toBe(false);
    });

    it('JSON-invalid: unchanged existing message', () => {
      tmpDir = copyFixture('simple-app');
      writeAlignFile(tmpDir, 'ruleset-ir.json', '{ not valid json');
      expect(() => readRulesetIr(tmpDir)).toThrow(/is not valid JSON/);
    });

    it('missing file: unchanged behavior (returns undefined)', () => {
      tmpDir = copyFixture('simple-app');
      expect(readRulesetIr(tmpDir)).toBeUndefined();
    });
  });
});
