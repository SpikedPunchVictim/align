import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No tracked source file may contain a raw control byte that makes git and grep treat it as BINARY.
 *
 * **Three instances, so it is an invariant rather than a note** (CLAUDE.md section 2: a shape with a
 * second instance has earned promotion). Found 2026-08-19 by two independent bug-hunt lens passes:
 * `baseline/fingerprint.ts`, `baseline/scan-history.ts` and `plugin-typescript/tsconfig-resolver.ts`
 * each wrote a literal NUL inside a string instead of the `\u0000` escape. The runtime value is
 * identical — a one-character string either way, and the fix was proved hash-for-hash identical
 * before it shipped — so nothing about the code was wrong. What was wrong was that the FILES stopped
 * being readable by the tools this project's review depends on:
 *
 *     grep -rn  "computeContentFingerprint" .../fingerprint.ts   ->  nothing
 *     grep -a -c "computeContentFingerprint" .../fingerprint.ts  ->  1
 *     git show --stat -- .../fingerprint.ts  ->  Bin 1489 -> 1499 bytes, 0 insertions, 0 deletions
 *
 * That is not cosmetic here. `computeContentFingerprint` is the function move-transfer matches on
 * (LEDGER D010/D015) and `scan-history.ts` is the whole of ADR 029's admissibility logic — the two
 * places this repository most needs a human to be able to read a diff of. And CLAUDE.md rule 3
 * requires a grep receipt for every claim of absence, so every such claim silently excluded these
 * files. The defect hid the evidence that would have found it.
 *
 * **Why a test and not an `align` rule.** A control byte is not an architecture violation, so making
 * it turn `align check` red would miscategorise it, and a `custom.host` predicate would not survive
 * `align check --untrusted` (ADR 014/017). For a USER's repository the right surface is an
 * `align doctor` advisory — read-only, always exit 0, repo hygiene rather than conformance. For THIS
 * repository the right surface is this test, which is stricter and costs nothing.
 *
 * **Walked rather than `git ls-files`-ed**, deliberately: `node:child_process` is forbidden inside
 * `packages/core/**` by align's own ruleset (`align.config.ts`, ADR 017's dogfood migration), and a
 * test that had to be exempted from the rules it ships would be a poor advertisement.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Directories that are not ours to police: dependencies, build output, caches, and the integration
 * harness's scratch space. `fixtures` is deliberately NOT skipped — a fixture is source too, and a
 * fixture that needs real binary content should carry a non-source extension. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.cache', 'results', 'coverage', '.agents', 'test-apps']);

const SOURCE_EXT = new Set(['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js']);

/**
 * The bytes that make git call a file binary. NUL is the one that has actually bitten us; the rest
 * are included because they are equally invisible to a reviewer and arrive the same way — a control
 * character pasted where an escape was meant. Tab (09), newline (0a) and carriage return (0d) are
 * excluded: they are legitimate text.
 */
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path.join(dir, entry.name));
    }
    const abs = path.join(dir, entry.name);
    return entry.isFile() && SOURCE_EXT.has(path.extname(entry.name)) ? [abs] : [];
  });
}

describe('tracked source files are text, not binary', () => {
  it('contains no raw control byte in any source file', () => {
    const offenders = sourceFiles(repoRoot)
      // `latin1` so every byte maps to exactly one code unit — decoding as UTF-8 would let an
      // invalid sequence become U+FFFD and slip past the range test.
      .map((file) => ({ file, text: fs.readFileSync(file, 'latin1') }))
      .filter(({ text }) => FORBIDDEN.test(text))
      .map(({ file, text }) => {
        const at = text.search(FORBIDDEN);
        const line = text.slice(0, at).split('\n').length;
        const byte = text.charCodeAt(at).toString(16).padStart(2, '0');
        return `${path.relative(repoRoot, file)}:${line} (byte 0x${byte})`;
      });

    // If this fails: you almost certainly meant an ESCAPE, not the byte. A literal NUL and the text
    // `\u0000` are the same string at runtime — only one of them is visible to a reviewer.
    expect(offenders).toEqual([]);
  });

  it('would catch one if it came back — the pattern is calibrated, not decorative', () => {
    // Without this, a typo in FORBIDDEN leaves the check above permanently green, which is the
    // passes-for-the-wrong-reason shape [S-05] this project treats as severity zero in a guard.
    // Built with `String.fromCharCode` so this file cannot contain the byte it forbids.
    expect(FORBIDDEN.test(`hash.update('${String.fromCharCode(0)}')`)).toBe(true);
    expect(FORBIDDEN.test(String.fromCharCode(0x1f))).toBe(true);
    expect(FORBIDDEN.test(String.fromCharCode(0x0c))).toBe(true);
    // ...and does not fire on the escape that replaced it, nor on ordinary text and whitespace.
    expect(FORBIDDEN.test("hash.update('\\u0000')")).toBe(false);
    expect(FORBIDDEN.test('const x = 1;\n\tconst y = 2;\r\n')).toBe(false);
  });
});
