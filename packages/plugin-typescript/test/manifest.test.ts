import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeManifestScanner, scanManifests } from '../src/manifest.js';
import { loadWorkspacePackages } from '../src/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

describe('scanManifests (ADR 013 manifest scan domain)', () => {
  it('scans the root manifest plus every workspace member, without requiring node_modules', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'manifest-security'));
    expect(inventory.lockfilePresent).toBe(true);
    const files = inventory.manifests.map((m) => m.file).sort();
    expect(files).toEqual(['package.json', 'packages/foo/package.json']);
  });

  it('resolves specifiers through pnpm-lock.yaml importers (lockfile-backed, catalog-aware)', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'manifest-security'));
    const root = inventory.manifests.find((m) => m.file === 'package.json');
    expect(root?.dependencies).toEqual([
      { name: 'zod', specifier: '^3.23.8', field: 'dependencies', line: 6 },
      { name: 'vitest', specifier: '^2.1.4', field: 'devDependencies', line: 9 },
    ]);
  });

  it('probe-verified n8n case: xlsx CDN tarball and wa-sqlite git pin are both captured with their real specifiers', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'manifest-security'));
    const foo = inventory.manifests.find((m) => m.file === 'packages/foo/package.json');
    const byName = new Map(foo?.dependencies.map((d) => [d.name, d]));
    expect(byName.get('xlsx')?.specifier).toBe('https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz');
    expect(byName.get('wa-sqlite')?.specifier).toBe('github:rhashimoto/wa-sqlite#779219540f66cecaa159da32b3b8936697ba10a7');
    expect(byName.get('left-pad')?.specifier).toBe('^1.3.0');
    expect(byName.get('xlsx')?.line).toBeGreaterThan(0);
  });

  it('falls back to the raw package.json specifier when no pnpm-lock.yaml is present', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'manifest-no-lockfile'));
    expect(inventory.lockfilePresent).toBe(false);
    expect(inventory.manifests).toHaveLength(1);
    const byName = new Map(inventory.manifests[0]?.dependencies.map((d) => [d.name, d.specifier]));
    expect(byName.get('xlsx')).toBe('https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz');
    expect(byName.get('left-pad')).toBe('^1.3.0');
  });

  it('returns just the root manifest for a repo with no pnpm-workspace.yaml', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'clean'));
    expect(inventory.manifests).toEqual([]); // `clean` fixture has no package.json at all
  });
});

describe('NodeManifestScanner (ManifestScanner injection seam, ADR 013)', () => {
  it('implements @spikedpunch/align-core\'s ManifestScanner interface', async () => {
    const scanner = new NodeManifestScanner();
    const inventory = await scanner.scan({ rootDir: path.join(fixturesDir, 'manifest-security'), excludes: [] });
    expect(inventory.manifests.length).toBeGreaterThan(0);
  });
});

/**
 * Pins the exemption `GateOrchestrator.runSecurityGate` (`core/src/orchestrator.ts`) relies on when
 * it passes `[]` for `BaselineStore.reconcileMoves`'s now-REQUIRED `blindSpots`
 * (review 2026-08-13). That `[]` is only correct if the manifest domain performs no nested-checkout
 * auto-exclusion of its own — i.e. a manifest can never go missing from `knownFiles` the way task
 * #25's `TypeScriptScanner` drops a source file (`plugin-typescript/test/nested-checkout.test.ts`
 * asserts that scanner DOES skip these). CLAUDE.md rule 4's discipline: an exemption is pinned by an
 * executable test, never asserted in a comment. So this is deliberately the exact inverse of the
 * scanner test's `expect(...).not.toContain(...)`.
 */
describe('the manifest scan domain does NOT auto-exclude nested checkouts (pins runSecurityGate\'s `[]`)', () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a workspace member whose directory carries its own `.git` is still scanned into the inventory', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-manifest-nested-checkout-test-'));
    // The scan root has its own `.git`, as every real repo does — same reasoning as
    // `nested-checkout.test.ts`'s setup, so "the root is never skipped" is a real assertion.
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'root', dependencies: { zod: '^3.23.8' } }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'vendor/*'\n", 'utf8');

    const memberDir = path.join(dir, 'vendor', 'submodule');
    fs.mkdirSync(memberDir, { recursive: true });
    // A linked worktree's `.git` is a FILE, not a directory — the shape `hasOwnGit` catches in the
    // source-scanning domain, used here so this fixture is not weaker than the scanner's.
    fs.writeFileSync(path.join(memberDir, '.git'), 'gitdir: /elsewhere/.git/worktrees/submodule\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'package.json'), `${JSON.stringify({ name: 'submodule', dependencies: { 'left-pad': '^1.3.0' } }, null, 2)}\n`, 'utf8');

    const inventory = scanManifests(dir);

    expect(inventory.manifests.map((m) => m.file).sort()).toEqual(['package.json', 'vendor/submodule/package.json']);
  });
});

/**
 * ADR 028 F3: the manifest walker records its own blind spots.
 *
 * Before this, `runSecurityGate` passed `[]` and the walker recorded nothing, which left a real
 * forged-transfer window — a `package.json` inside an unreadable directory is on disk, absent from
 * the inventory, covered by no blind spot, and reads absent to the existence probe (`existsSync`
 * swallows the `EACCES`), so it reached `applyMoves`' content-fingerprint match. Collisions there
 * are the NORM: a manifest violation's snippet is the dependency line itself, identical across
 * every workspace package pinning the same dependency.
 */
describe('scanManifests records what it could not turn into a record (ADR 028 F3)', () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) {
      const locked = path.join(dir, 'locked');
      if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function repo(): string {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-manifest-blind-spots-')));
    fs.writeFileSync(path.join(d, 'package.json'), `${JSON.stringify({ name: 'root' })}\n`, 'utf8');
    return d;
  }

  it('records a MALFORMED package.json as unparseable, not as absent — corrupt is not deleted (BUG #1)', () => {
    dir = repo();
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "root", ', 'utf8');

    const inventory = scanManifests(dir, []);

    expect(inventory.manifests).toHaveLength(0);
    expect(inventory.blindSpots).toHaveLength(1);
    expect(inventory.blindSpots[0]?.path).toBe('package.json');
    expect(inventory.blindSpots[0]?.reason.kind).toBe('unparseable');
    // The parse error is carried, so the advisory can tell a user to go fix their JSON rather than
    // sending them to look at permissions.
    expect((inventory.blindSpots[0]?.reason as { error: string }).error).toMatch(/JSON/i);
  });

  it('records an UNREADABLE manifest, where the old existsSync-first read reported genuine absence', () => {
    dir = repo();
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'locked'\n", 'utf8');
    fs.mkdirSync(path.join(dir, 'locked'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'locked', 'package.json'), `${JSON.stringify({ name: 'locked' })}\n`, 'utf8');
    // Loaded as a workspace member first, THEN made unreadable — otherwise `loadWorkspacePackages`
    // could not read its name and the member would never be enumerated at all.
    const members = loadWorkspacePackages(dir).map((p) => p.name);
    expect(members).toContain('locked');
    fs.chmodSync(path.join(dir, 'locked'), 0o000);

    const inventory = scanManifests(dir, []);

    const unreadable = inventory.blindSpots.filter((s) => s.reason.kind === 'unreadable');
    expect(unreadable.map((s) => s.path)).toEqual(['locked/package.json']);
  });

  it('does NOT record a genuinely absent manifest — ENOENT is the one sound absence', () => {
    dir = repo();
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'members/*'\n", 'utf8');
    fs.mkdirSync(path.join(dir, 'members', 'ghost'), { recursive: true });

    const inventory = scanManifests(dir, []);

    // A directory with no `package.json` is not a blind spot: there is nothing there, so an entry
    // for it really was deleted. Recording it would make prune a no-op for genuinely-removed
    // packages — retention has to stay a claim align can defend.
    expect(inventory.blindSpots).toEqual([]);
  });

  it('records an EXCLUDED workspace member against its directory, naming the pattern', () => {
    dir = repo();
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'vendor'\n", 'utf8');
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor', 'package.json'), `${JSON.stringify({ name: 'vendored' })}\n`, 'utf8');

    const inventory = scanManifests(dir, ['vendor']);

    expect(inventory.manifests.map((m) => m.file)).toEqual(['package.json']);
    // Against the DIRECTORY, so at-or-under containment covers the manifest beneath it.
    expect(inventory.blindSpots).toEqual([{ path: 'vendor', reason: { kind: 'excluded', pattern: 'vendor' } }]);
  });

  it('records nothing for an ordinary healthy repo', () => {
    dir = repo();
    expect(scanManifests(dir, []).blindSpots).toEqual([]);
  });
});

/**
 * The manifest domain's own absence exits, above the per-manifest read that ADR 028 F3 already
 * fixed. `buildManifestRecord` and `loadWorkspacePackages` both read-then-branch-on-`code`
 * correctly — but neither runs at all if the layer that decides WHICH directories are members
 * fails silently first. That is shape S-09 again (the inner loop was fixed, the guard deciding
 * whether the loop runs was not), and all four cases below were measured against the built
 * scanner before the fix: the member manifest vanished from the inventory and `blindSpots` was
 * `[]` — align looked at a fraction of the repo and said nothing.
 *
 * **What these records are and are not for.** A malformed `pnpm-workspace.yaml` makes the member
 * set unknowable, so there is no precise path to record containment against — the affected
 * manifests are exactly the ones we could not enumerate. These records therefore REPORT
 * (mechanism 1) while retention falls to the file-existence probe (mechanism 2), which already
 * covers them: a member's `package.json` is still on disk and unobserved, so it is retained.
 * Recording the repo root instead, to force containment, would retain every entry in the
 * repository whenever a lockfile is malformed — shape S-04, safe and useless. The unreadable
 * DIRECTORY case is different and does record a containing path, because there the affected
 * subtree is known exactly.
 */
describe('scanManifests records the absence exits ABOVE the per-manifest read (task #11)', () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) {
      for (const rel of ['packages', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
        const p = path.join(dir, rel);
        if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A two-package pnpm workspace: root plus `packages/member`. Every test below breaks exactly one
   * thing about it, so a dropped member is attributable to that one break. */
  function workspaceRepo(): string {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-manifest-exits-')));
    fs.writeFileSync(path.join(d, 'package.json'), `${JSON.stringify({ name: 'root' })}\n`, 'utf8');
    fs.mkdirSync(path.join(d, 'packages', 'member'), { recursive: true });
    fs.writeFileSync(path.join(d, 'packages', 'member', 'package.json'), `${JSON.stringify({ name: 'member' })}\n`, 'utf8');
    fs.writeFileSync(path.join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n", 'utf8');
    return d;
  }

  it('is calibrated: the healthy workspace finds the member and records nothing', () => {
    dir = workspaceRepo();
    const inventory = scanManifests(dir, []);
    // Without this, every assertion below is satisfied by a repo whose member was never findable.
    expect(inventory.manifests.map((m) => m.file)).toEqual(['package.json', 'packages/member/package.json']);
    expect(inventory.blindSpots).toEqual([]);
  });

  it('records a MALFORMED pnpm-workspace.yaml — a member set align could not read is not an empty one', () => {
    dir = workspaceRepo();
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n   bad: [oops\n", 'utf8');

    const inventory = scanManifests(dir, []);

    expect(inventory.blindSpots.map((s) => ({ path: s.path, kind: s.reason.kind }))).toEqual([
      { path: 'pnpm-workspace.yaml', kind: 'unparseable' },
    ]);
  });

  it('records an UNREADABLE pnpm-workspace.yaml, which existsSync reported as simply absent', () => {
    dir = workspaceRepo();
    fs.chmodSync(path.join(dir, 'pnpm-workspace.yaml'), 0o000);

    const inventory = scanManifests(dir, []);

    expect(inventory.blindSpots.map((s) => ({ path: s.path, kind: s.reason.kind }))).toEqual([
      { path: 'pnpm-workspace.yaml', kind: 'unreadable' },
    ]);
  });

  it('records a MALFORMED pnpm-lock.yaml instead of silently reporting no lockfile', () => {
    dir = workspaceRepo();
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'importers:\n  .: [unclosed\n', 'utf8');

    const inventory = scanManifests(dir, []);

    // `lockfilePresent: false` on a lockfile that is right there is corrupt-read-as-absent (BUG #1's
    // class). It also silently changes RESULTS: every `catalog:` specifier falls back to its raw
    // package.json text, so the security gate evaluates a different string than the one that ships.
    expect(inventory.blindSpots.map((s) => ({ path: s.path, kind: s.reason.kind }))).toEqual([
      { path: 'pnpm-lock.yaml', kind: 'unparseable' },
    ]);
  });

  it('records an UNREADABLE workspace directory against the directory, where containment is exact', () => {
    dir = workspaceRepo();
    fs.chmodSync(path.join(dir, 'packages'), 0o000);

    const inventory = scanManifests(dir, []);

    // Unlike the config-file cases above, the affected subtree is known precisely here, so this
    // record carries a path that at-or-under containment can actually use.
    expect(inventory.blindSpots.map((s) => ({ path: s.path, kind: s.reason.kind }))).toEqual([
      { path: 'packages', kind: 'unreadable' },
    ]);
  });

  it.each([['packages/**'], ['packages/*'], ['packages/{member,other}']])(
    'excludes %s the same way the source walker does — one entry cannot hide sources but keep the manifest',
    (pattern) => {
      dir = workspaceRepo();

      const inventory = scanManifests(dir, [pattern]);

      // The divergence this pins: the manifest domain matched exact-or-directory-prefix only, with
      // no glob and no `/**` handling, so every pattern above excluded the member's SOURCES while
      // its package.json stayed in the inventory — one `excludes` entry meaning two different things
      // depending on which walker read it. Measured before the fix: `blindSpots: []` and the member
      // manifest present for all three. Both domains now go through the source walker's own matcher.
      expect(inventory.manifests.map((m) => m.file)).toEqual(['package.json']);
      expect(inventory.blindSpots.map((sp) => ({ path: sp.path, kind: sp.reason.kind }))).toEqual([
        { path: 'packages/member', kind: 'excluded' },
      ]);
    },
  );

  it('excludes a member whose MANIFEST the pattern matches, even when the directory does not match', () => {
    dir = workspaceRepo();

    // The residual half of the divergence, found by adversarial review of the first fix and missed
    // by it. The source walker tests FILE paths; this domain tested only the member DIRECTORY. So
    // `packages/member/*` — which matches `packages/member/package.json` but NOT `packages/member`
    // — excluded the package's sources while leaving its manifest in the inventory. That is exactly
    // the "one entry, two meanings" defect the first fix claimed to close, and the UPGRADING note
    // shipped `packages/vendor/*` as its worked example, so the documented case was the broken one.
    const inventory = scanManifests(dir, ['packages/member/*']);

    expect(inventory.manifests.map((m) => m.file)).toEqual(['package.json']);
    // Recorded against the MANIFEST here, not the directory: the pattern excluded that file, and
    // claiming containment over the whole directory would over-retain everything beside it.
    expect(inventory.blindSpots.map((sp) => ({ path: sp.path, kind: sp.reason.kind }))).toEqual([
      { path: 'packages/member/package.json', kind: 'excluded' },
    ]);
  });

  it('does NOT record a genuinely absent pnpm-workspace.yaml or lockfile — ENOENT stays sound', () => {
    dir = workspaceRepo();
    fs.rmSync(path.join(dir, 'pnpm-workspace.yaml'));

    // No workspace declaration at all is the ordinary single-package repo, and no lockfile is the
    // ordinary pre-install one. Neither is a blind spot, and recording them would put an advisory
    // on nearly every repository align sees — the fastest way to teach users to ignore advisories.
    expect(scanManifests(dir, []).blindSpots).toEqual([]);
  });
});
