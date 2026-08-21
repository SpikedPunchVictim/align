/**
 * The release step that used to fail silently, now checked.
 *
 * `KNOWN_ALIGN_VERSIONS` (lib/normalize.mjs) is what scrubs align's own version strings out of
 * captured output. It was a hand-written literal ending at the current release, so a version bump
 * that forgot to extend it left `local`'s version raw in normalized text — no test went red,
 * scenarios that print a version just stopped being comparable across runs, and `RELEASING.md` had
 * to carry it as a thing a human remembers.
 *
 * It is now derived from `packages/cli/package.json`. These tests guard the DERIVATION, not the
 * list: if anyone reverts to a literal, or the reader starts defaulting instead of throwing, the
 * silent failure comes back and this is what says so.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownAlignVersions, readWorkingTreeAlignVersion, PUBLISHED_ALIGN_VERSIONS } from './align-version.mjs';
import { normalizeText, makeNormalizeContext } from './normalize.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')).version;

describe("the harness knows the working tree's align version", () => {
  it('reads it from packages/cli/package.json — the same file ALIGN_VERSION reads', () => {
    assert.equal(readWorkingTreeAlignVersion(), cliVersion);
  });

  it('offers the working tree version for scrubbing, whatever it is', () => {
    // Named for what it actually checks: `knownAlignVersions()` itself, NOT the list normalize.mjs
    // ends up using. Those are different claims, and only the end-to-end test below can make the
    // second one — verified by mutation (reverting normalize.mjs to a hand-written literal missing
    // the current version leaves THIS test green and fails that one). Stated against the file on
    // disk rather than a literal, so it holds across every future bump untouched.
    assert.ok(knownAlignVersions().includes(cliVersion), `knownAlignVersions() must include ${cliVersion}`);
  });

  it('still includes every published version', () => {
    for (const v of PUBLISHED_ALIGN_VERSIONS) assert.ok(knownAlignVersions().includes(v), `missing published version ${v}`);
  });

  it('de-duplicates when the working tree sits on an already-published version', () => {
    // True for the whole span between a publish and the next bump.
    const list = knownAlignVersions();
    assert.equal(list.length, new Set(list).size);
  });
});

// A real context, built the way `scenario-runner.mjs` builds it — `normalizeText` strips absolute
// paths before it touches versions, so it needs one. `keepVersion: false` is the default a scenario
// gets unless it opts out.
const ctx = makeNormalizeContext('/tmp/does-not-matter', '/private/tmp/does-not-matter', false);

describe('the derived list is what normalization actually uses', () => {
  it("scrubs the working tree's own version from captured text", () => {
    // End-to-end through `normalizeText`, because a correct list wired to nothing is the shape
    // this repo keeps finding [S-13]. `align upgrade`'s real headline is the text under test.
    const out = normalizeText(`align upgrade: unknown -> ${cliVersion} (baseline last reconciled under 0.1.4)`, ctx);
    assert.ok(!out.includes(cliVersion), `expected ${cliVersion} to be normalized away, got: ${out}`);
    assert.ok(!out.includes('0.1.4'), `expected 0.1.4 to be normalized away, got: ${out}`);
  });

  it('leaves a third-party version that merely CONTAINS an align version alone', () => {
    // F7's boundary rule: `10.1.4` embeds `0.1.4` and must survive untouched, or a genuine
    // dependency-version difference in captured output becomes invisible.
    const out = normalizeText('nest v10.1.4 and @nestjs/core@10.1.3', ctx);
    assert.ok(out.includes('10.1.4'), `expected 10.1.4 to survive, got: ${out}`);
    assert.ok(out.includes('10.1.3'), `expected 10.1.3 to survive, got: ${out}`);
  });
});
