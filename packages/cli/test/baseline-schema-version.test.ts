import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseline, readBaselineSnapshot, writeBaseline } from '../src/align-dir.js';
import { BASELINE_SCHEMA_VERSION, toRepoRelativePath, toRuleId, toViolationId, type BaselineEntry } from '@spikedpunch/align-core';

/**
 * ADR 006's 2026-08-19 amendment: `.align/baseline.json` gains a schema version.
 *
 * **Why this file and not the others.** Every other structured `.align/` artifact already carried one
 * (`irVersion` on the three rules artifacts, `recordVersion` on the scan record). The baseline — the
 * only one holding irreplaceable human consent — was a bare JSON array, the one shape with nowhere to
 * put a version. Back-compat rested entirely on "every new field optional, object `.passthrough()`",
 * which is sound for ADDITIVE change forever and silent for SEMANTIC change; and the semantics most
 * likely to change are `fingerprint`/`contentFingerprint`, the identity deciding what transfers and
 * what gets pruned. A redefinition would have parsed cleanly and meant something else.
 *
 * **Two shapes, both first-class.** Version 1 is the legacy bare array, retroactively — every 0.1.x
 * repository still has one on disk, so reading it is not a compatibility nicety, it is the majority
 * case at the moment of upgrade. Version 2 is the envelope this align writes.
 */

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repo(): string {
  return (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-baseline-schema-')));
}

function entry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    fingerprint: toViolationId('f1'),
    ruleId: toRuleId('arch.no-dependency:api-to-db'),
    file: toRepoRelativePath('src/api/service.ts'),
    acceptedAt: 1_755_000_000_000,
    acceptedBy: 'manual',
    contentFingerprint: toViolationId('cf1'),
    ...overrides,
  };
}

function plant(dir: string, contents: unknown): string {
  const file = path.join(dir, '.align', 'baseline.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  return file;
}

describe('reading a baseline written by an older align (version 1: the bare array)', () => {
  it('reads a legacy array unchanged — entries, fields and all', () => {
    const dir = repo();
    plant(dir, [entry()]);

    const read = readBaseline(dir);

    expect(read).toHaveLength(1);
    expect(read[0]?.file).toBe('src/api/service.ts');
    expect(read[0]?.acceptedBy).toBe('manual');
    // The optional fields that carry ADR 006's move-transfer identity must survive the older shape,
    // or upgrading would silently downgrade every entry to "cannot participate in a transfer".
    expect(read[0]?.contentFingerprint).toBe('cf1');
  });

  it('reads a legacy EMPTY array as empty rather than as absent', () => {
    // `[]` is a statement the file makes ("nothing is accepted"); a missing file is the absence of a
    // statement. They coincide in value and must not coincide in meaning — `readBaselineSnapshot`'s
    // token distinguishes them, and that is what stops a racing `init` being overwritten.
    const dir = repo();
    plant(dir, []);

    expect(readBaseline(dir)).toEqual([]);
    expect(readBaselineSnapshot(dir).token).toBeDefined();
  });

  it('MIGRATES it on the first write, rather than writing back the shape it read', () => {
    // The alternative — preserve whatever shape was on disk — would leave the version marker absent
    // forever on exactly the repositories that predate it, which is the population it exists for.
    const dir = repo();
    const file = plant(dir, [entry()]);
    const { entries, token } = readBaselineSnapshot(dir);

    writeBaseline(dir, entries, token);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { schemaVersion: number; entries: unknown[] };
    expect(onDisk.schemaVersion).toBe(BASELINE_SCHEMA_VERSION);
    expect(onDisk.entries).toHaveLength(1);
    // ...and the entries are untouched by the migration: only the container changed.
    expect(readBaseline(dir)).toEqual(entries);
  });
});

describe('reading and writing the versioned envelope (version 2)', () => {
  it('round-trips through write and read', () => {
    const dir = repo();
    const entries = [entry(), entry({ fingerprint: toViolationId('f2'), file: toRepoRelativePath('src/api/other.ts') })];

    writeBaseline(dir, entries, undefined);

    expect(readBaseline(dir)).toHaveLength(2);
  });

  it('tolerates an unknown sibling field, so a later align adding one does not brick this one', () => {
    const dir = repo();
    plant(dir, { schemaVersion: BASELINE_SCHEMA_VERSION, entries: [entry()], writtenBy: 'align 0.3.0' });

    expect(readBaseline(dir)).toHaveLength(1);
  });
});

describe('an unrecognised version FAILS — it is never guessed at', () => {
  it('refuses a baseline from a NEWER align, and says to upgrade rather than rewrite', () => {
    // The destructive case this closes: a v3 align may have redefined what a fingerprint means. An
    // older align that parsed it optimistically would then write a full snapshot back under v2
    // semantics — BUG #1 with extra steps, and no worse form of this defect exists in the project.
    const dir = repo();
    plant(dir, { schemaVersion: BASELINE_SCHEMA_VERSION + 1, entries: [] });

    expect(() => readBaseline(dir)).toThrow(/newer align/);
  });

  it('refuses an object that carries no schemaVersion at all', () => {
    const dir = repo();
    plant(dir, { entries: [] });

    expect(() => readBaseline(dir)).toThrow(/neither a legacy baseline array nor a versioned baseline object/);
  });

  it('still refuses a syntactically broken file — the BUG #1 discipline is unchanged', () => {
    // The version check is ADDED to corrupt-is-never-empty, not a replacement for it. A truncated
    // write is the likeliest real corruption and must still throw rather than read as `[]`.
    const dir = repo();
    plant(dir, '{"schemaVersion":2,"entries":[{"fingerp');

    expect(() => readBaseline(dir)).toThrow(/not valid JSON/);
  });

  it('refuses a JSON scalar, the shape a half-written file can also produce', () => {
    const dir = repo();
    plant(dir, '"nonsense"');

    expect(() => readBaseline(dir)).toThrow();
  });
});
