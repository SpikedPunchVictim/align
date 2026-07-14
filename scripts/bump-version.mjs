#!/usr/bin/env node
// Manual lockstep versioning: write one version into every publishable package.
//
// Internal deps use the `workspace:*` protocol, which pnpm rewrites to the
// concrete version at publish time — so there is nothing else to update here.
// This script only touches the five publishable packages, never the private
// monorepo root. `create-align` (packages/create-align) reads its OWN version
// at runtime (never hardcoded) to pin the align-cli/align-core devDependencies
// it installs, so keeping it in lockstep here is what makes that pin correct.
//
//   node scripts/bump-version.mjs 0.2.0      (or: pnpm release:version 0.2.0)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/bump-version.mjs <x.y.z[-prerelease]>');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['core', 'plugin-typescript', 'cli', 'agent', 'create-align'];

for (const name of packages) {
  const path = join(root, 'packages', name, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const prev = pkg.version ?? '(none)';
  pkg.version = version;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  packages/${name}: ${prev} -> ${version}`);
}

console.log(`\nAll ${packages.length} packages set to ${version}. Next steps:`);
console.log(`  pnpm install --lockfile-only       # refresh pnpm-lock.yaml`);
console.log(`  git commit -am "release: v${version}"`);
console.log(`  git tag v${version} && git push --follow-tags   # CI publishes on the tag`);
