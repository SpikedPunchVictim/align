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
//     "<the monorepo's current version>"` — a bare version indistinguishable from a real published
//     one). Whenever the monorepo's version equals the latest PUBLISHED version — which is the
//     steady state for the whole span between a publish and the next bump — installing the
//     `align-cli` tarball naively would have npm resolve its declared `align-core@<that version>`
//     dependency from the REGISTRY, silently testing a Frankenstein mix of local cli/core and
//     published agent/plugin-typescript. Whether the numbers happen to collide RIGHT NOW depends
//     only on where in the publish/bump cycle the tree is sitting, which is why this is fixed
//     structurally rather than by relying on them to differ — a comment naming the version of the
//     day would be stale by the next release and was, twice. Fixed with npm's `overrides` field (npm >= 8.3): forces
//     every transitive resolution of the four `@spikedpunch/*` package names to their local
//     tarball, regardless of what version range is declared anywhere in the tree — no version
//     bump needed, no publish-time coordination, package.json `version` fields stay untouched.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from './exec.mjs';
import { ensureDir, removeDir, readJson, writeJson, sha256File } from './fs-utils.mjs';

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
 * version string (`'0.1.4'`) or the literal `'local'`.
 *
 * `alignOnlyInstall` (increment 2, ADR 025 §4's "second, deliberately incomplete project variant"
 * — `projects/nest-incomplete.mjs`): when true, the project's OWN `dependencies`/`devDependencies`
 * are dropped entirely before writing, so the `npm install` this triggers resolves ONLY align's
 * four packages (plus their own transitive deps) and never touches the project's real dependency
 * tree. Verified empirically (2026-08-10, scratch npm project): a plain `npm install <one-pkg>`
 * against a package.json that ALSO lists other, uninstalled dependencies installs those too — npm
 * always reconciles the WHOLE tree against package.json, there is no "install just this package"
 * mode once other deps are declared. Stripping them from the object BEFORE npm ever sees it is the
 * only reliable way to keep them uninstalled while still installing align itself. */
function writePackageJsonFor(workingDir, version, tarballs, options = {}) {
  const pkgJsonPath = path.join(workingDir, 'package.json');
  const pkg = readJson(pkgJsonPath);
  const devDependencies = options.alignOnlyInstall ? {} : { ...pkg.devDependencies };
  // Always fully replace (not merge) the align-related overrides on every install, so a scenario
  // that installs two versions in sequence into the SAME working copy (a real cross-version
  // scenario shape, out of scope for increment 1 but the mechanism must not silently leak a stale
  // override from an earlier install) never carries the previous version's pins forward.
  const overrides = options.alignOnlyInstall ? {} : { ...pkg.overrides };
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

  const rest = options.alignOnlyInstall ? { ...pkg, dependencies: {} } : pkg;
  writeJson(pkgJsonPath, { ...rest, devDependencies, overrides });
}

/**
 * F5: the ORIGINAL authenticity check compared the installed `align-cli` version string against
 * `packages/cli/package.json`'s version — but for the whole span between a publish and the next
 * bump, that string EQUALS the latest published version (align's own version field doesn't move
 * until a release, see the release process this file's header comment describes). If the
 * `overrides` field ever silently stopped applying — `pnpm`/`npm` behavior change, a workspace
 * `.npmrc` shadowing it, a lockfile quirk — npm would fall back to resolving that same version of
 * `align-cli`/`align-core` from the REGISTRY, and the version check alone could not tell that apart
 * from a genuine local install: both report the same number.
 *
 * Whether the numbers happen to differ at any given moment is a coincidence of the publish/bump
 * cycle, not a property to lean on — which is exactly why the two checks below do not consult the
 * version string at all. (This paragraph used to say "the tree is momentarily bumped to 0.2.0,
 * unpublished, so today the numbers differ"; that sentence survived 0.2.0 actually shipping and
 * would need rewriting at every release. It now states the invariant instead of the date.)
 *
 * Two INDEPENDENT, stronger checks, both required to pass:
 *
 *   1. `package-lock.json` provenance: every one of the four `@spikedpunch/*` packages must have
 *      resolved from a `file:` spec (a local tarball), not a registry URL. This directly verifies
 *      the "resolved specs are file: tarballs" property — a registry fallback shows up as a
 *      `https://registry.npmjs.org/...` (or similar) `resolved` field instead.
 *   2. Content check: `dist/index.js` for each package, as actually installed into
 *      `node_modules`, must be BYTE-IDENTICAL (sha256) to the working tree's own build. A registry
 *      install of the same version number is a genuinely different build (different source at
 *      publish time) and would fail this even in the pathological case where check 1 were somehow
 *      also fooled.
 */
function verifyLocalInstallAuthenticity(workingDir, alignRepoRoot, log) {
  const lockPath = path.join(workingDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    throw new Error(`local install authenticity check: ${lockPath} does not exist — cannot verify align was resolved from a local tarball, not the registry.`);
  }
  const lock = readJson(lockPath);
  const lockedPackages = lock.packages ?? {};

  for (const pkg of LOCAL_PACKAGES_IN_DEPENDENCY_ORDER) {
    const scopedName = SCOPED_NAME[pkg];
    const key = `node_modules/${scopedName}`;
    const entry = lockedPackages[key];
    if (entry === undefined) {
      throw new Error(`local install authenticity check: package-lock.json has no entry for '${key}' — cannot verify its resolution source.`);
    }
    const resolved = entry.resolved ?? '';
    if (!resolved.startsWith('file:')) {
      throw new Error(
        `local install authenticity check FAILED for ${scopedName}: package-lock.json resolved it from '${resolved}', not a local file: tarball. ` +
          `This means 'local' may silently be testing a REGISTRY package instead of the working tree under review — the ` +
          `npm 'overrides' field this install depends on did not apply as expected.`,
      );
    }

    const shortName = scopedName.split('/')[1];
    const installedDist = path.join(workingDir, 'node_modules', '@spikedpunch', shortName, 'dist', 'index.js');
    const workingTreeDist = path.join(alignRepoRoot, 'packages', pkg, 'dist', 'index.js');
    if (!fs.existsSync(installedDist)) {
      throw new Error(`local install authenticity check: ${installedDist} does not exist after install.`);
    }
    if (!fs.existsSync(workingTreeDist)) {
      throw new Error(`local install authenticity check: ${workingTreeDist} does not exist — run \`pnpm -r build\` before installing 'local'.`);
    }
    const installedHash = sha256File(installedDist);
    const workingTreeHash = sha256File(workingTreeDist);
    if (installedHash !== workingTreeHash) {
      throw new Error(
        `local install authenticity check FAILED for ${scopedName}: installed dist/index.js (sha256 ${installedHash}) does not match the ` +
          `working tree's own build (sha256 ${workingTreeHash}) at ${workingTreeDist} — 'local' is not testing the code under review.`,
      );
    }
  }
  log('[version-install] local install authenticity verified: all four packages resolved from file: tarballs, dist/index.js content matches the working tree build');
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
  writePackageJsonFor(workingDir, version, tarballs, { alignOnlyInstall: options.alignOnlyInstall === true });

  // `--legacy-peer-deps`: must match the flag the base install used (project.mjs's
  // `installCmd`) — nest's own tree has an unresolved ERESOLVE conflict (see projects/nest.mjs),
  // and `npm install` re-resolves peers for the whole tree on every invocation, not just the
  // newly-added align packages, so omitting it here would fail even though the base install
  // already succeeded.
  //
  // `--ignore-scripts` for `alignOnlyInstall` only: `writePackageJsonFor` strips the project's own
  // `dependencies`/`devDependencies` for that variant, so its `prepare`/`postinstall` lifecycle
  // scripts (nest's root package.json runs `husky` on `prepare`) reference tooling that was
  // deliberately never installed — verified empirically (2026-08-10): a plain `npm install` here
  // fails with `sh: husky: command not found` (exit 127), a harness/environment-looking failure
  // that has nothing to do with align. The normal (non-`alignOnlyInstall`) path never sets this —
  // running a real project's own lifecycle scripts is part of installing it for real.
  const installArgs = ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'];
  if (options.alignOnlyInstall) installArgs.push('--ignore-scripts');
  const install = run('npm', installArgs, { cwd: workingDir, timeoutMs: 5 * 60 * 1000 });
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

  // F5: the version-string check above is necessary but not sufficient for 'local' — see
  // `verifyLocalInstallAuthenticity`'s doc comment for why a version-string match alone cannot
  // distinguish a genuine local-tarball install from a silent registry fallback resolving the
  // same version number.
  if (version === 'local') {
    verifyLocalInstallAuthenticity(workingDir, options.alignRepoRoot, options.log ?? (() => {}));
  }

  return { installLog: install, installedVersion };
}
