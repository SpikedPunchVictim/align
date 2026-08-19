import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId, type BaselineEntry } from '@spikedpunch/align-core';
import { ensureAlignDir, readBaseline, readBaselineSnapshot, writeBaseline, writeRulesLock } from '../src/align-dir.js';

/**
 * LEDGER **D034** (bug hunt B2) — a destructive write must not land and then report failure.
 *
 * Every committed-artifact writer is two-phase: `writeFileAtomic(...)` then `stampAlignVersion`. The
 * second phase reads `.align/version.json` and throws on a corrupt one — a merge conflict or a
 * half-written stamp is enough — and until this fix that throw arrived AFTER the first phase had
 * already replaced the file. Measured before the fix:
 *
 *     BEFORE: 1 entries
 *     $ align baseline prune --yes
 *     align baseline prune: .../.align/version.json is not valid JSON: Expected property name or '}'
 *     AFTER : 0 entries
 *
 * The user is told the command FAILED, with a message naming a file they did not ask about, while
 * their consent records are gone and the prune report never prints. `commands/baseline.ts` states the
 * invariant this violated in its own comment — "a refusal still leaves the baseline file untouched" —
 * which was true of the ADR 023 refusals and false of this one.
 *
 * The fix is `preflightVersionStamp`, the `build.ts` precedent applied where it was missing: validate
 * before the first write, inside the same lock, so the sequence is all-or-nothing.
 */

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repoWithCorruptStamp(): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-preflight-')));
  ensureAlignDir(dir);
  fs.writeFileSync(path.join(dir, '.align', 'version.json'), '{corrupt');
  return dir;
}

function entry(fingerprint: string): BaselineEntry {
  return {
    fingerprint: toViolationId(fingerprint),
    ruleId: toRuleId('arch.no-dependency:api-to-db'),
    file: toRepoRelativePath('src/api/service.ts'),
    acceptedAt: 1_755_000_000_000,
    acceptedBy: 'manual',
    contentFingerprint: toViolationId('cf1'),
  };
}

describe('a write that cannot finish does not start', () => {
  it('leaves the baseline byte-identical when the version stamp is unreadable', () => {
    // Seed on a HEALTHY repo — the corruption has to arrive between the accept and the prune, which
    // is exactly how it arrives in life (a merge conflict, a half-written stamp from a killed run).
    const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-preflight-')));
    writeBaseline(dir, [entry('f1'), entry('f2')], undefined);
    fs.writeFileSync(path.join(dir, '.align', 'version.json'), '{corrupt');
    const before = fs.readFileSync(path.join(dir, '.align', 'baseline.json'), 'utf8');

    // `undefined` token: a stale token would refuse for a DIFFERENT reason and the test would pass
    // without exercising the pre-flight at all [S-05]. Re-read it so the only thing that can refuse
    // this write is the corrupt stamp.
    const token = readBaselineSnapshot(dir).token;
    expect(() => writeBaseline(dir, [entry('f1')], token)).toThrow(/not valid JSON/);

    // The assertion that matters, and the one the existing concurrent-write test never made: not the
    // exit code, not the message — the DATA.
    expect(fs.readFileSync(path.join(dir, '.align', 'baseline.json'), 'utf8')).toBe(before);
    expect(readBaseline(dir)).toHaveLength(2);
  });

  it('applies to every committed-artifact writer, not just the baseline', () => {
    // The same two-phase shape is in `writeGeneratedRules`, `writeRulesLock` and `writeRulesetIr`;
    // `build --apply` reaches it, where a partial write leaves doc-built rules in force with no
    // lockfile — `build --verify` then reports the build never happened. Pinning one sibling keeps
    // the fix a class rather than an instance.
    const dir = repoWithCorruptStamp();

    expect(() =>
      writeRulesLock(dir, {
        irVersion: '1',
        docPath: 'doc.md',
        docContentHash: 'h',
        builtAt: 1,
        sections: [],
        generatedRulesContentHash: 'h',
      }),
    ).toThrow(/not valid JSON/);

    expect(fs.existsSync(path.join(dir, '.align', 'rules.lock.json'))).toBe(false);
  });

  it('still writes normally when the stamp is readable, or absent entirely', () => {
    // Calibration: a guard that refused every write would satisfy both tests above. An ABSENT
    // `version.json` is the ordinary state for a repo that has only ever run `check`, and must not be
    // confused with a corrupt one — that distinction is the whole of `readVersionFile`'s contract.
    const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-preflight-ok-')));

    expect(() => writeBaseline(dir, [entry('f1')], undefined)).not.toThrow();

    expect(readBaseline(dir)).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, '.align', 'version.json'))).toBe(true);
  });
});
