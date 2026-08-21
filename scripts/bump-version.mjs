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

// The next-steps list deliberately does NOT include `pnpm install --lockfile-only`. It used to,
// which contradicted this file's own header ("there is nothing else to update here") — internal
// deps are recorded in pnpm-lock.yaml as `workspace:*` / `link:packages/*`, with no version number
// anywhere, so a bump cannot change the lockfile. Verified 2026-08-21; the v0.2.0 release commit
// did not touch it either.
//
// It no longer mentions the integration harness's `KNOWN_ALIGN_VERSIONS` either. That WAS a manual
// step, and the only one whose omission no test could detect; it is now derived from this very
// file's output via `integration/lib/align-version.mjs`. Removing a step beats documenting it.
//
// What remains are the two edits this script genuinely cannot make, because both need authorship.
console.log(`\nAll ${packages.length} packages set to ${version}. Two edits remain (RELEASING.md Step 3):\n`);
console.log(`  1. MIGRATION_REGISTRY entry for ${version} — packages/cli/src/migrations/registry.ts`);
console.log(`     ADD a new entry. Do NOT re-key the previous one: that withdraws its validators`);
console.log(`     and notes from everyone who has not upgraded past it.`);
console.log(`  2. UPGRADING.md's "## ${version}" section, then recompile:`);
console.log(`       node packages/cli/scripts/compile-upgrading-notes.mjs\n`);
console.log(`Both fail loudly if skipped. Then verify and ship:\n`);
console.log(`  pnpm build && pnpm typecheck && pnpm test && pnpm test:harness`);
console.log(`  pnpm integration:release        # ~25min; read the calibration line, not just the exit code`);
console.log(`  git commit -am "release: v${version}"`);
console.log(`  git tag v${version} && git push --follow-tags   # CI publishes on the tag`);
