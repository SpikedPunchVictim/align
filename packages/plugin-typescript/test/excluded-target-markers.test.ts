/**
 * LEDGER D066 — the per-edge marker for "this import points outside the scan" was named for one
 * cause and fired for a different one, and never fired for the cause it was named after.
 *
 * The reporter's amendment to finding 1, and the sharp part of it: **the false-green detector for
 * D052 already existed and was already correctly named.** `UncertaintyReason` has enumerated
 * `build-output-excluded` since ADR 004. What it actually fired on was `isExcludedPath(targetRel,
 * excludes)` — the USER's config patterns — so:
 *
 *   - an import into `dist/`, the literal build output the reason is NAMED for, produced no marker
 *     at all. Fixture 01 (D052) emitted nothing, which is why the resolver defect was silent;
 *   - an import into a user-excluded test-fixture directory WAS reported as `build-output-excluded`,
 *     which claims to know something the scanner cannot know. `fixture-excluded` sat in the same
 *     enum, produced by nothing (`grep`: one definition, one doc mention, zero call sites) — a
 *     vocabulary richer than the code that filled it.
 *
 * Both halves are the same defect: the marker described the *supposed reason for a path being out
 * of scope* rather than the *fact the walk actually recorded*. The fix routes both through
 * `ScanBlindSpotReason`, ADR 028's already-discriminated record of why the walk skipped something,
 * so the marker reports what happened instead of guessing why.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeScriptPlugin } from '../src/plugin.js';
import { toComponentName } from '@spikedpunch/align-core';
import type { ComponentDefinitionIR, DependencyGraph, UncertaintyMarker } from '@spikedpunch/align-core';

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repo(): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-excluded-target-')));
  const w = (rel: string, content = 'export const x = 1;\n'): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  };
  w('package.json', JSON.stringify({ name: 'root', private: true }));
  w('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }));

  // (a) an import reaching into real build output at a package root — the D052 shape.
  w('packages/core/package.json', JSON.stringify({ name: 'core', main: 'dist/index.js' }));
  w('packages/core/dist/generated.ts');
  w('packages/core/src/reaches-into-dist.ts', "import { x } from '../dist/generated.js';\nexport const y = x;\n");

  // (b) an import reaching into a directory the USER excluded — the mislabel shape.
  w('packages/core/testfixtures/sample.ts');
  w('packages/core/src/reaches-into-fixtures.ts', "import { x } from '../testfixtures/sample.js';\nexport const z = x;\n");

  // (c) a control: an ordinary in-scope import, which must produce an edge and no marker.
  w('packages/core/src/helper.ts');
  w('packages/core/src/uses-helper.ts', "import { x } from './helper.js';\nexport const w = x;\n");
  return dir;
}

const COMPONENTS: Readonly<Record<string, ComponentDefinitionIR>> = {
  [toComponentName('core')]: { name: 'core', selector: { kind: 'glob', patterns: ['packages/core/**'] }, empty: 'allow' },
};

async function scan(): Promise<DependencyGraph> {
  return new TypeScriptPlugin().scanner.scan({
    rootDir: repo(),
    components: COMPONENTS,
    excludes: ['**/testfixtures/**'],
  });
}

function markersFrom(g: DependencyGraph, file: string): UncertaintyMarker[] {
  return g.uncertain.filter((m) => String(m.file) === file);
}

describe('a target outside the scan is reported as what the walk recorded (LEDGER D066)', () => {
  it('an import into real build output produces a marker — the case the reason is NAMED for', async () => {
    const g = await scan();
    const markers = markersFrom(g, 'packages/core/src/reaches-into-dist.ts');

    // Before the fix this array was EMPTY: the edge was created pointing at a file the walk had
    // skipped, no marker was recorded, and nothing per-edge said the target was unevaluatable.
    expect(markers).toHaveLength(1);
    expect(markers[0]?.reason).toBe('build-output-excluded');
    expect(markers[0]?.excludedBy).toEqual({ kind: 'default-excluded-dir', name: 'dist' });
  });

  it('an import into a user-excluded directory no longer claims to be build output', async () => {
    const g = await scan();
    const markers = markersFrom(g, 'packages/core/src/reaches-into-fixtures.ts');

    expect(markers).toHaveLength(1);
    // The scanner cannot know what a user's pattern MEANS. It knows which pattern matched, so that
    // is what it reports — and the reason name stops making a claim it cannot support.
    expect(markers[0]?.reason).toBe('excluded-from-scan');
    expect(markers[0]?.excludedBy).toEqual({ kind: 'excluded', pattern: '**/testfixtures/**' });
  });

  it('an ordinary in-scope import produces an edge and no marker', async () => {
    const g = await scan();

    expect(markersFrom(g, 'packages/core/src/uses-helper.ts')).toEqual([]);
    expect(g.edges.some((e) => String(e.from) === 'packages/core/src/uses-helper.ts' && String(e.to) === 'packages/core/src/helper.ts')).toBe(true);
  });

  it('every marker whose target left the scan names the blind spot responsible', async () => {
    // The invariant, rather than the two instances: a marker that says "outside the scan" must be
    // able to say WHICH recorded blind spot put it there. `undefined` here would be the same
    // unfalsifiable claim the old `build-output-excluded` label was.
    const g = await scan();
    const outOfScope = g.uncertain.filter((m) => m.reason === 'build-output-excluded' || m.reason === 'excluded-from-scan');

    expect(outOfScope.length).toBeGreaterThan(0);
    for (const marker of outOfScope) {
      expect(marker.excludedBy).toBeDefined();
      expect(g.blindSpots.some((b) => b.reason.kind === marker.excludedBy?.kind)).toBe(true);
    }
  });
});
