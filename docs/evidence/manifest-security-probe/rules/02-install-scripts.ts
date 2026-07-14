// Rule 2: Install-script exposure.
// Walks the offline node_modules/.pnpm store (where populated) and reports
// every *installed* package declaring preinstall/install/postinstall.
// Explicitly does NOT predict scripts for uninstalled packages from the
// lockfile alone — pnpm-lock.yaml v9 does not record hasInstallScript per
// package (verified: grep for that field across all three lockfiles found
// zero hits). Where node_modules isn't populated for real deps (n8n in this
// probe), this rule reports zero direct findings and says so explicitly
// rather than silently under-counting.
import type { Finding, RepoTarget, RuleResult } from '../lib/types.ts';
import { listInstalledPackages, dedupeByNameVersion, readJson } from '../lib/read.ts';
import path from 'node:path';
import type { PackageJson } from '../lib/types.ts';

// Known native-build / bundler-toolchain packages that commonly ship
// install scripts for legitimate reasons (downloading a prebuilt binary,
// compiling a native addon). Presence here is not a pass — it's a
// classification for the human reviewing the list.
const KNOWN_BUILD_TOOLING = new Set([
  'esbuild',
  'sharp',
  'better-sqlite3',
  'sqlite3',
  'node-gyp',
  'node-pty',
  'canvas',
  'playwright',
  'playwright-core',
  'puppeteer',
  'puppeteer-core',
  'cypress',
  'husky',
  'simple-git-hooks',
  'deasync',
  'bcrypt',
  'protobufjs',
  'keytar',
  'robotjs',
  'fsevents',
  'core-js',
  '@swc/core',
  '@parcel/watcher',
  'msgpackr-extract',
  'unrs-resolver',
  'lightningcss',
  '@biomejs/biome',
  'turbo',
  'workerd',
  'wrangler',
  'sqlite-vec',
  're2',
  'libxmljs2',
  'utf-8-validate',
  'bufferutil',
  'isolated-vm',
  '@vscode/ripgrep',
  'sass-embedded',
  'spawn-sync',
]);

export function run(target: RepoTarget): RuleResult {
  const start = performance.now();
  const findings: Finding[] = [];
  const notes: string[] = [];

  const installed = dedupeByNameVersion(listInstalledPackages(target.root));

  if (installed.length === 0) {
    notes.push(
      'node_modules/.pnpm not populated with real dependencies for this repo — offline install-script census is not possible without a real `pnpm install`. See fallback signal below.'
    );
    // Fallback offline signal: pnpm's own onlyBuiltDependencies allowlist in
    // the repo's package.json (if present) tells us pnpm's script-blocking
    // default is active and names the packages explicitly permitted to run
    // scripts — a partial, config-level proxy, not a census.
    const rootPkg = readJson<PackageJson & { pnpm?: { onlyBuiltDependencies?: string[]; ignoredBuiltDependencies?: string[] } }>(
      path.join(target.root, 'package.json')
    );
    const allow = rootPkg?.pnpm?.onlyBuiltDependencies;
    if (allow?.length) {
      notes.push(
        `fallback signal: root package.json declares pnpm.onlyBuiltDependencies allowlist of ${allow.length}: ${allow.join(', ')} — implies pnpm blocks install scripts for everything else by default, but does not tell us how many *other* packages have scripts that are being blocked.`
      );
    }
    return {
      ruleId: 'install-scripts',
      repo: target.id,
      wallTimeMs: performance.now() - start,
      count: 0,
      findings,
      notes,
    };
  }

  notes.push(`census: ${installed.length} distinct installed packages (deduped by name@version)`);

  for (const pkg of installed) {
    const scripts = pkg.manifest.scripts;
    if (!scripts) continue;
    const hits = (['preinstall', 'install', 'postinstall'] as const).filter((k) => scripts[k]);
    if (hits.length === 0) continue;

    const name = pkg.manifest.name ?? '(unnamed)';
    const classification = KNOWN_BUILD_TOOLING.has(name) ? 'build-tooling' : 'unclassified';
    findings.push({
      repo: target.id,
      location: path.relative(target.root, pkg.manifestPath),
      detail: `${name}@${pkg.manifest.version ?? '?'}: ${hits.join(', ')} [${classification}]`,
      extra: { name, version: pkg.manifest.version, hooks: hits, classification, scripts: hits.map((h) => scripts[h]) },
    });
  }

  return {
    ruleId: 'install-scripts',
    repo: target.id,
    wallTimeMs: performance.now() - start,
    count: findings.length,
    findings,
    notes,
  };
}
