import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * EXECUTABLE INVARIANT for shape [S-09], promoted after LEDGER **D037**.
 *
 * Every module that writes `.align/baseline.json` must have decided, in writing, what it does when
 * another align is writing the same file — and a NEW writer must not be able to inherit either
 * answer by saying nothing.
 *
 * **Why this one is worth mechanising.** S-09 ("fixed one arm, missed the other") is the Shape column
 * of 13 of the ledger's 39 rows — recounted from `LEDGER.md` on 2026-08-19, not from `SHAPES.md`'s
 * register, which was stale by six. This sub-family had already produced two instances: ADR 030's
 * first version let the refusal escape `align check` and turn a green repo into a bare exit-1, and
 * D037 found the identical thing on the MCP surface a month later. `freshCheck`'s own header had
 * predicted it — "this function is the one that keeps getting missed", naming two prior misses by
 * name — which is the strongest possible evidence that a comment is not a control.
 *
 * **The judgement cannot be inferred from syntax, which is exactly why it must be declared.** Both
 * answers are correct for somebody:
 *
 *  - `check` and the MCP tools compute a move-transfer whose loss costs nothing, because the next
 *    run re-derives and re-persists it unconditionally. Their ANSWER does not depend on the write, so
 *    failing the command would discard a valid result over a transient collision.
 *  - `baseline accept`/`prune`, `init` and `build --apply` exist TO write. Nothing was recorded, so
 *    a silent success would be a lie about the user's consent records.
 *
 * A test that demanded one behaviour everywhere would therefore be wrong. What it can demand is that
 * the choice is on the record, so the next writer meets a failing test rather than a default.
 */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Writers whose ANSWER does not depend on the write: they must catch the refusal and carry on.
 * The value is the reason, kept here so this file is the register rather than a list of paths.
 */
const MUST_DEGRADE = new Map<string, string>([
  [
    'commands/check.ts',
    'the verdict is already computed and the in-memory store already applied the transfer; the next run redoes it (ADR 030).',
  ],
  ['mcp/server.ts', 'same transfer, same reasoning, for an agent that has no stderr to read — the note becomes a payload advisory (D037).'],
]);

/** Writers whose PURPOSE is the write: a refusal means nothing was recorded and must be reported. */
const MUST_FAIL_LOUDLY = new Map<string, string>([
  ['commands/baseline.ts', 'accept and prune exist to change the baseline; a silent success would misreport a consent decision.'],
  ['commands/init.ts', 'seeding is the command; a partially-seeded baseline reported as seeded is the BUG #10 class.'],
  ['commands/build.ts', 'the accepted entries are half of what `build --apply` produced; the other half is already on disk.'],
]);

/**
 * Every `.ts` under `src/` that CALLS `writeBaseline`, excluding the module that defines it.
 *
 * Textual, and deliberately not comment-aware: a file that only MENTIONS `writeBaseline(` in a doc
 * comment would be flagged as a writer. That is the safe direction — the failure mode is "you were
 * asked to classify one module too many", never "a real writer slipped through unclassified", which
 * is the only failure that matters here. Checked on 2026-08-19: all five matches have real calls
 * outside comments (2, 1, 1, 2, 1), so the tolerance is currently costing nothing.
 */
function baselineWriterModules(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const rel = path.relative(srcDir, abs).split(path.sep).join('/');
      // `align-dir.ts` DEFINES `writeBaseline` and raises the error; it is not one of its callers.
      if (rel === 'align-dir.ts') continue;
      if (/\bwriteBaseline\s*\(/.test(fs.readFileSync(abs, 'utf8'))) out.push(rel);
    }
  };
  walk(srcDir);
  return out.sort();
}

describe('every baseline writer has declared what it does about a concurrent align [S-09]', () => {
  it('classifies every writer — a new one fails here until its author chooses', () => {
    const declared = new Set([...MUST_DEGRADE.keys(), ...MUST_FAIL_LOUDLY.keys()]);
    const found = baselineWriterModules();

    // PREMISE [S-05]: if the detector stops finding writers, every assertion below passes vacuously.
    // Five is the count on 2026-08-19; the number is not the point, a non-empty result is.
    expect(found.length).toBeGreaterThanOrEqual(5);

    const unclassified = found.filter((f) => !declared.has(f));
    // If this fails: you added a `writeBaseline` call site. Decide whether this command's ANSWER
    // depends on the write (degrade, like `check`) or IS the write (fail loudly, like `prune`), then
    // add it to the matching map above WITH the reason. Do not add it to both, and do not delete
    // this test — that decision is the one D037 shows nobody makes from memory.
    expect(unclassified).toEqual([]);

    // The register must not rot in the other direction either: a path that no longer writes is a
    // stale exemption, and a stale exemption reads as a reviewed decision.
    const stale = [...declared].filter((f) => !found.includes(f));
    expect(stale).toEqual([]);
  });

  it('a degrading writer actually consults the predicate, not a message string', () => {
    // The error is a TYPE precisely so nobody matches on prose (`concurrent-write-error.ts`'s own
    // header). A module that claimed to degrade but tested `err.message.includes(...)` would rot the
    // first time the wording changed, and the rot would be silent.
    for (const [file, reason] of MUST_DEGRADE) {
      const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
      expect(source, `${file} must degrade (${reason})`).toContain('isConcurrentAlignWriteError');
    }
  });

  it('every classification carries a reason, so the register stays a decision record', () => {
    for (const [file, reason] of [...MUST_DEGRADE, ...MUST_FAIL_LOUDLY]) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});
