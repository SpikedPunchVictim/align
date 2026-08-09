// Version installation — ADR 025 §"Version installation". Two paths:
//
//   - PUBLISHED (`0.1.0`–`0.1.4`): plain devDependency version strings; npm resolves the matching
//     `@spikedpunch/align-agent`/`align-plugin-typescript` transitively from the registry, because
//     align's own release process rewrites `workspace:*` to the exact published version at
//     publish time (verified: `npm view @spikedpunch/align-cli@0.1.4 dependencies` shows
//     `"@spikedpunch/align-core": "0.1.4"`, a bare version, not `workspace:*`).
//   - LOCAL: `pnpm pack` the four working-tree packages (core, plugin-typescript, agent, cli — in
//     that dependency order) and install the tarballs. THE FIDDLY PART: `pnpm pack` rewrites each
//     package's `workspace:*` dependency to its CURRENT VERSION NUMBER (verified empirically:
//     packing plugin-typescript, whose package.json says `"@spikedpunch/align-core":
//     "workspace:*"`, produces a tarball whose package.json says `"@spikedpunch/align-core":
//     "0.1.4"` — a bare version indistinguishable from a real published one). Since the
//     monorepo's version today (0.1.4) collides with the latest PUBLISHED version, installing the
//     `align-cli` tarball naively would have npm resolve its declared `align-core@0.1.4`
//     dependency from the REGISTRY, silently testing a Frankenstein mix of local cli/core and
//     published agent/plugin-typescript. Fixed with npm's `overrides` field (npm >= 8.3): forces
//     every transitive resolution of the four `@spikedpunch/*` package names to their local
//     tarball, regardless of what version range is declared anywhere in the tree — no version
//     bump needed, no publish-time coordination, package.json `version` fields stay untouched.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from './exec.mjs';
import { ensureDir, removeDir, readJson, writeJson } from './fs-utils.mjs';

const LOCAL_PACKAGES_IN_DEPENDENCY_ORDER = ['core', 'plugin-typescript', 'agent', 'cli'];
const SCOPED_NAME = {
  core: '@spikedpunch/align-core',
  'plugin-typescript': '@spikedpunch/align-plugin-typescript',
  agent: '@spikedpunch/align-agent',
  cli: '@spikedpunch/align-cli',
};

/** Packs the four working-tree packages into `destDir`, in dependency order (so a pack failure on
 * an earlier package fails fast rather than producing a tarball that embeds a stale dependency).
 * Requires `pnpm -r build` to have already produced `dist/` for each — checked explicitly with a
 * clear message rather than left to fail obscurely inside `pnpm pack` (which packs whatever
 * `files` lists, stale or not, without erroring on a missing dist). Always repacks (no staleness
 * cache) — packing four small packages takes well under a second combined, and a stale local
 * tarball masking a just-made code change is a far more expensive mistake to debug than the cost
 * of repacking. */
export function packLocalTarballs(alignRepoRoot, destDir, log = () => {}) {
  removeDir(destDir);
  ensureDir(destDir);
  const tarballs = {};
  for (const pkg of LOCAL_PACKAGES_IN_DEPENDENCY_ORDER) {
    const pkgDir = path.join(alignRepoRoot, 'packages', pkg);
    const distDir = path.join(pkgDir, 'dist');
    if (!fs.existsSync(distDir)) {
      throw new Error(`packages/${pkg}/dist does not exist — run \`pnpm -r build\` in ${alignRepoRoot} before installing 'local'.`);
    }
    const result = run('pnpm', ['pack', '--pack-destination', destDir], { cwd: pkgDir });
    if (result.exitCode !== 0) throw new Error(`pnpm pack failed for packages/${pkg}:\n${result.stderr}`);
    const tgz = result.stdout
      .trim()
      .split('\n')
      .pop()
      .trim();
    tarballs[pkg] = tgz;
    log(`[version-install] packed ${SCOPED_NAME[pkg]} -> ${path.basename(tgz)}`);
  }
  return tarballs;
}

/** Reads `workingDir/package.json`, rewrites its align-related `devDependencies`/`overrides` for
 * `version`, and writes it back — every other field untouched. `version` is either a published
 * version string (`'0.1.4'`) or the literal `'local'`. */
function writePackageJsonFor(workingDir, version, tarballs) {
  const pkgJsonPath = path.join(workingDir, 'package.json');
  const pkg = readJson(pkgJsonPath);
  const devDependencies = { ...pkg.devDependencies };
  // Always fully replace (not merge) the align-related overrides on every install, so a scenario
  // that installs two versions in sequence into the SAME working copy (a real cross-version
  // scenario shape, out of scope for increment 1 but the mechanism must not silently leak a stale
  // override from an earlier install) never carries the previous version's pins forward.
  const overrides = { ...pkg.overrides };
  for (const name of Object.values(SCOPED_NAME)) delete overrides[name];

  if (version === 'local') {
    devDependencies[SCOPED_NAME.cli] = `file:${tarballs.cli}`;
    devDependencies[SCOPED_NAME.core] = `file:${tarballs.core}`;
    for (const pkg2 of LOCAL_PACKAGES_IN_DEPENDENCY_ORDER) {
      overrides[SCOPED_NAME[pkg2]] = `file:${tarballs[pkg2]}`;
    }
  } else {
    devDependencies[SCOPED_NAME.cli] = version;
    devDependencies[SCOPED_NAME.core] = version;
  }

  writeJson(pkgJsonPath, { ...pkg, devDependencies, overrides });
}

/**
 * Installs align `version` ('local' or a published version string) as a devDependency into
 * `workingDir` — the real user flow (ADR 025 task brief: "a transitive or global install is not
 * sufficient — align emits a specific error for this"). Runs a real `npm install` every call
 * (project.mjs's cached base checkout already has nest's OWN dependencies installed, so this is a
 * small incremental install — the align packages plus their own small dependency trees — not a
 * full reinstall). Verifies the installed `align-cli` version afterward and throws loudly on a
 * mismatch rather than letting a silent wrong-version install produce a confusing scenario
 * failure three steps later.
 */
export function installAlignVersion(workingDir, version, options) {
  const tarballs = version === 'local' ? packLocalTarballs(options.alignRepoRoot, options.tarballCacheDir, options.log) : undefined;
  writePackageJsonFor(workingDir, version, tarballs);

  // `--legacy-peer-deps`: must match the flag the base install used (project.mjs's
  // `installCmd`) — nest's own tree has an unresolved ERESOLVE conflict (see projects/nest.mjs),
  // and `npm install` re-resolves peers for the whole tree on every invocation, not just the
  // newly-added align packages, so omitting it here would fail even though the base install
  // already succeeded.
  const install = run('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: workingDir, timeoutMs: 5 * 60 * 1000 });
  if (install.exitCode !== 0) {
    throw new Error(`npm install (align ${version}) failed in ${workingDir} (exit ${install.exitCode}):\n${install.stderr.slice(-4000)}`);
  }

  const installedCliPkgPath = path.join(workingDir, 'node_modules', '@spikedpunch', 'align-cli', 'package.json');
  if (!fs.existsSync(installedCliPkgPath)) {
    throw new Error(`align ${version} install reported success but ${installedCliPkgPath} does not exist`);
  }
  const installedVersion = readJson(installedCliPkgPath).version;
  const expectedVersion = version === 'local' ? readJson(path.join(options.alignRepoRoot, 'packages', 'cli', 'package.json')).version : version;
  if (installedVersion !== expectedVersion) {
    throw new Error(`align ${version} install produced align-cli@${installedVersion}, expected @${expectedVersion}`);
  }

  return { installLog: install, installedVersion };
}
