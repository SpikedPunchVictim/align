import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanManifests } from '../src/manifest.js';

/**
 * LEDGER **D039** (bug hunt B10) — a `package.json` whose shape is legal JSON but not a legal
 * manifest must be recorded as a blind spot, not allowed to throw, and never turned into fabricated
 * dependencies.
 *
 * `buildManifestRecord` puts `JSON.parse` inside a `try` — the corrupt-≠-absent discipline ADR 028
 * brought to this walker — and then reads `pkg[field]` and `Object.entries(declared)` OUTSIDE it.
 * Both assume a shape `JSON.parse` never promised. Measured before the fix, against
 * `packages/plugin-typescript/dist/manifest.js`:
 *
 *     THROW dependencies: null       TypeError: Cannot convert undefined or null to object
 *     THROW devDependencies: null    TypeError: Cannot convert undefined or null to object
 *     THROW top-level null           TypeError: Cannot read properties of null (reading 'dependencies')
 *     OK    dependencies: string     manifests=1 deps=4 blindSpots=0
 *     OK    healthy                  manifests=1 deps=1 blindSpots=0
 *
 * The throw is caught by `orchestrator.ts`'s manifest-scan `catch`, so it does not crash the
 * process — it errors the whole SECURITY GATE with a raw `TypeError` naming no file, and returns
 * `blindSpots: []`, discarding every blind spot the walker had already recorded before it reached
 * the bad manifest. One `"dependencies": null` in one workspace member takes out the gate for the
 * entire repository and tells the user nothing about which file to fix.
 *
 * **The fourth row is the one the bug hunt missed, and it is worse than the three throws.**
 * `"dependencies": "oops"` does not throw: `Object.entries` of a string yields its characters, so
 * align invents four dependencies named `0`,`1`,`2`,`3` and evaluates `security.manifest.*` rules
 * against them. A wrong answer reported as a clean one, which this project ranks above a crash.
 *
 * The sibling `workspace.ts` already reads its parsed value inside the `try`; this is shape [S-09]
 * again — the same walk, hardened in one file and not the other.
 */

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repoWithRootManifest(body: string): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-manifest-shape-')));
  fs.writeFileSync(path.join(dir, 'package.json'), body);
  return dir;
}

describe('the manifest walker survives a package.json that parses but is not a manifest', () => {
  it.each([
    ['a null dependency field', '{"name":"x","dependencies":null}'],
    ['a null devDependencies field', '{"name":"x","devDependencies":null}'],
    ['a null optionalDependencies field', '{"name":"x","optionalDependencies":null}'],
    ['a top-level null', 'null'],
    ['a top-level string', '"not a manifest"'],
  ])('records %s as an unparseable blind spot instead of throwing', (_label, body) => {
    const inventory = scanManifests(repoWithRootManifest(body), []);

    // Blind spot, NOT absence: the file is on disk and the user can fix it. Reporting it absent is
    // what lets `prune` delete the entries under it as "fixed" (the whole point of ADR 028 here).
    expect(inventory.blindSpots.map((s) => s.path)).toEqual(['package.json']);
    expect(inventory.blindSpots[0]?.reason.kind).toBe('unparseable');
    expect(inventory.manifests).toEqual([]);
  });

  it('never fabricates dependencies from a string dependency field', () => {
    // The finding the crash was hiding. `Object.entries("oops")` is `[['0','o'],...]`, so align
    // used to report four dependencies that do not exist and run the security rules over them.
    const inventory = scanManifests(repoWithRootManifest('{"name":"x","dependencies":"oops"}'), []);

    expect(inventory.manifests.flatMap((m) => m.dependencies)).toEqual([]);
    expect(inventory.blindSpots[0]?.reason.kind).toBe('unparseable');
  });

  it('names the offending file in the reason, so the user can fix it', () => {
    const inventory = scanManifests(repoWithRootManifest('{"dependencies":null}'), []);

    const reason = inventory.blindSpots[0]?.reason;
    expect(reason?.kind).toBe('unparseable');
    // A raw `TypeError: Cannot convert undefined or null to object` names neither the file nor the
    // field. The message has to say which field is wrong or the advisory is unactionable [S-04].
    expect(reason?.kind === 'unparseable' ? reason.error : '').toContain('dependencies');
  });

  it('still reads a healthy manifest, and still tolerates a missing dependency field', () => {
    // Calibration [S-04]: a guard that rejected anything unusual would satisfy every test above.
    // `{}` and a manifest with no dependency fields at all are both completely ordinary.
    const healthy = scanManifests(repoWithRootManifest('{"name":"x","dependencies":{"left-pad":"1.0.0"}}'), []);
    expect(healthy.manifests).toHaveLength(1);
    expect(healthy.manifests[0]?.dependencies.map((d) => d.name)).toEqual(['left-pad']);
    expect(healthy.blindSpots).toEqual([]);

    const bare = scanManifests(repoWithRootManifest('{"name":"x"}'), []);
    expect(bare.manifests).toHaveLength(1);
    expect(bare.manifests[0]?.dependencies).toEqual([]);
    expect(bare.blindSpots).toEqual([]);

    const empty = scanManifests(repoWithRootManifest('{}'), []);
    expect(empty.manifests).toHaveLength(1);
    expect(empty.blindSpots).toEqual([]);
  });

  it('an array dependency field is rejected too — arrays are objects, so this one is easy to miss', () => {
    // `Object.entries([])` is `[]`, so an array field produced a manifest with zero dependencies and
    // no blind spot: align silently reported that a package declares nothing. Absence of a crash is
    // not evidence of a correct read.
    const inventory = scanManifests(repoWithRootManifest('{"name":"x","dependencies":["left-pad"]}'), []);

    expect(inventory.blindSpots[0]?.reason.kind).toBe('unparseable');
    expect(inventory.manifests).toEqual([]);
  });

  it('an empty pnpm-lock.yaml is a blind spot, not a lockfile align read', () => {
    // `readLockfile`'s own header says `lockfilePresent` must tell three states apart — absent,
    // unreadable, unparseable. An empty or comment-only lockfile parses to `null`, which reported as
    // a lockfile successfully read while resolving nothing. Not a crash; a false statement.
    const dir = repoWithRootManifest('{"name":"x"}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '# nothing here yet\n');

    const inventory = scanManifests(dir, []);

    expect(inventory.lockfilePresent).toBe(false);
    expect(inventory.blindSpots.map((s) => s.path)).toEqual(['pnpm-lock.yaml']);
    // Calibration: a real lockfile still reads as present.
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n");
    expect(scanManifests(dir, []).lockfilePresent).toBe(true);
  });
});
