import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAgentInstructions } from '../src/init/claude-md.js';
import { writeGeneratedRulesNote } from '../src/init/config-comment.js';
import { ensureAlignLocalFilesGitignored } from '../src/init/gitignore.js';

/**
 * LEDGER **D046** (bug hunt FRAGILE F1) — a file align does NOT own must be replaced atomically,
 * not truncated in place.
 *
 * `fs.writeFileSync` opens with `O_TRUNC`: the old contents are gone before the new ones land, so a
 * process killed in that window (Ctrl-C, OOM, a closing laptop, CI cancelling a job) leaves a
 * truncated or empty file. `fs-atomic.ts` exists precisely because of this and its header argues
 * the case at length — for `.align/`. Every `.align/` artifact goes through `writeFileAtomic`;
 * every file align writes into someone ELSE'S repository did not:
 *
 *     init/claude-md.ts      CLAUDE.md          fs.writeFileSync   x2
 *     init/config-comment.ts align.config.ts    fs.writeFileSync
 *     init/gitignore.ts      .gitignore         fs.writeFileSync
 *     init/npm-script.ts     package.json       fs.writeFileSync
 *     commands/init.ts       align.config.ts    fs.writeFileSync
 *     commands/agent.ts      the user's SOURCE  fs.writeFileSync
 *     skill/install.ts       .claude/skills/*   fs.writeFileSync
 *     migrations/…rewrite.ts align.config.ts    fs.writeFileSync
 *
 * The inversion is the finding. `.align/baseline.json` is align's own artifact, recoverable in the
 * worst case by re-accepting; `CLAUDE.md` and `package.json` are the human's, and align cannot
 * regenerate a line of them. CLAUDE.md's own rule 3 names the first two as shared files whose
 * outside-the-markers content must survive byte-identical — a rule about WHAT align writes that
 * says nothing about what a crash mid-write leaves behind. ADR 030's "what this does not do"
 * enumerates only `.align/` paths, so nothing in the design ever asked the question. [S-09], and
 * the arm that was fixed is the less valuable one.
 *
 * **Confidence, stated rather than implied: this is `inferred from code`, not `measured`.** The
 * truncation window is a crash window; it cannot be reproduced in-process, and no test below claims
 * to. What IS measured is the structural fact — the call sites above, enumerated by grep — and the
 * behaviour of the replacement (mode and symlink identity preserved, content correct). The
 * invariant test is what keeps the class closed, since the next writer will be added by someone who
 * never read this file.
 */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * The only call sites in `packages/cli/src` allowed to reach `fs` write primitives directly, each
 * with the reason it cannot go through `writeFileAtomic`. A new entry here is a claim, not a
 * formality — if you are adding one, the question to answer is "what would a crash mid-write leave
 * behind, and who owns that file?"
 */
const DIRECT_WRITE_EXEMPTIONS = new Map<string, string>([
  [
    'align-lock.ts',
    'writes its own temp holder file which is then published by an atomic `link` — it IS the atomicity mechanism, and routing it through another one would be circular. Nothing reads the temp path.',
  ],
  [
    'align-dir.ts',
    '`appendTelemetryLine` APPENDS to .align/telemetry.jsonl. An append does not truncate, so the crash window this invariant exists for does not exist; a torn final line is the documented worst case for a JSONL log.',
  ],
]);

/** Every `.ts` under `src/` that calls an `fs` write primitive directly. Textual and deliberately
 * not comment-aware, the same tolerance `baseline-writers-classify-concurrency.test.ts` takes and
 * for the same reason: the safe failure is "you were asked to classify one file too many". */
function directWriteModules(): string[] {
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
      if (rel === 'fs-atomic.ts') continue; // the implementation itself
      if (/\bfs\.(writeFileSync|appendFileSync|createWriteStream)\s*\(/.test(fs.readFileSync(abs, 'utf8'))) out.push(rel);
    }
  };
  walk(srcDir);
  return out.sort();
}

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repo(): string {
  return (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-atomic-write-')));
}

describe('every write goes through writeFileAtomic unless exempted in writing [D046]', () => {
  it('no unclassified direct fs write survives in packages/cli/src', () => {
    const found = directWriteModules();

    // PREMISE [S-05]: if the detector matches nothing the assertion below is vacuous. Two is the
    // exemption count; a detector that silently stopped working would report zero.
    expect(found.length).toBeGreaterThanOrEqual(DIRECT_WRITE_EXEMPTIONS.size);

    const unclassified = found.filter((f) => !DIRECT_WRITE_EXEMPTIONS.has(f));
    // If this fails: you wrote a file with `fs.writeFileSync`. Use `writeFileAtomic`
    // (`fs-atomic.ts`) — or, if the write genuinely cannot be atomic, add it above WITH the reason.
    expect(unclassified).toEqual([]);

    // A stale exemption reads as a reviewed decision, so it must not outlive its call site.
    const stale = [...DIRECT_WRITE_EXEMPTIONS.keys()].filter((f) => !found.includes(f));
    expect(stale).toEqual([]);
  });

  it('every exemption carries a real reason', () => {
    for (const [file, reason] of DIRECT_WRITE_EXEMPTIONS) {
      expect(reason.length, `${file} needs a reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});

describe('replacing a human-owned file preserves what the human set on it [D046]', () => {
  it('CLAUDE.md keeps its permission bits', () => {
    // The calibration that a naive temp-file-plus-rename fix would fail: a rename installs a NEW
    // inode under the process umask. Measured on `.align/baseline.json` when `fs-atomic.ts` was
    // first written — 0600 came back 0644 — and align has even less business widening permissions
    // on a file it did not create.
    const dir = repo();
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Project notes\n\nHand-written, outside any align marker.\n', 'utf8');
    fs.chmodSync(file, 0o600);

    writeAgentInstructions(dir);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toContain('Hand-written, outside any align marker.');
  });

  it('align.config.ts written through a symlink updates the TARGET, not the link', () => {
    // Repos share config across git worktrees by symlink. A rename replaces the link with a regular
    // file, silently forking the two worktrees — reproduced against `.align/baseline.json` when
    // `fs-atomic.ts` was written, and the same configuration is legal here.
    const dir = repo();
    const real = path.join(dir, 'align.config.real.ts');
    const link = path.join(dir, 'align.config.ts');
    fs.writeFileSync(real, 'export default {};\n', 'utf8');
    fs.symlinkSync(real, link);

    writeGeneratedRulesNote(link);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toContain('align:generated-rules-note');
  });

  it('.gitignore keeps every line the human wrote', () => {
    const dir = repo();
    const file = path.join(dir, '.gitignore');
    fs.writeFileSync(file, 'node_modules/\ndist/\n', 'utf8');

    ensureAlignLocalFilesGitignored(dir);

    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain('node_modules/');
    expect(after).toContain('dist/');
  });
});
