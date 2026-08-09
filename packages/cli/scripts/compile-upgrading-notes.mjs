#!/usr/bin/env node
// Compiles the repo-root UPGRADING.md into packages/cli/src/migrations/notes.generated.ts (ADR
// 011's doc-is-source pattern applied to ADR 022's notes tier). Run this after any edit to
// UPGRADING.md, then re-run `pnpm test` — `migration-notes-drift.test.ts` fails if the generated
// file's embedded content hash falls out of sync with UPGRADING.md's current text.
//
// Imports the compiler from the CLI package's BUILT dist, not its TypeScript source, so this
// tooling script needs no extra runtime (no ts-node/tsx dependency) — it just requires
// `pnpm --filter @spikedpunch/align-cli build` (or `pnpm build`) to have run first, same as any
// other consumer of the CLI's compiled output.
//
//   pnpm --filter @spikedpunch/align-cli build
//   node packages/cli/scripts/compile-upgrading-notes.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileUpgradingNotes } from '../dist/migrations/notes-compiler.js';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cliDir = join(scriptsDir, '..');
const repoRoot = join(cliDir, '..', '..');
const docPath = join(repoRoot, 'UPGRADING.md');
const outPath = join(cliDir, 'src', 'migrations', 'notes.generated.ts');

const docText = readFileSync(docPath, 'utf8');
const { notesByVersion, contentHash } = compileUpgradingNotes(docText);

function tsStringLiteral(value) {
  return JSON.stringify(value);
}

function renderNote(note, indent) {
  return (
    `${indent}{\n` +
    `${indent}  heading: ${tsStringLiteral(note.heading)},\n` +
    `${indent}  body: ${tsStringLiteral(note.body)},\n` +
    `${indent}},\n`
  );
}

function renderNotesByVersion(map) {
  const versions = Object.keys(map);
  let out = '{\n';
  for (const version of versions) {
    out += `  ${tsStringLiteral(version)}: [\n`;
    for (const note of map[version]) out += renderNote(note, '    ');
    out += '  ],\n';
  }
  out += '}';
  return out;
}

const generatedAt = new Date().toISOString();
const fileContents =
  `// GENERATED FILE — do not hand-edit.\n` +
  `//\n` +
  `// Compiled from the repo-root UPGRADING.md by scripts/compile-upgrading-notes.mjs (ADR 011's\n` +
  `// doc-is-source pattern applied to ADR 022's notes tier). UPGRADING.md itself is not published\n` +
  `// in the npm package (it is not listed in package.json's "files", and it lives outside\n` +
  `// packages/cli/src entirely, so tsc would not even see it) — this file is how its notes reach an\n` +
  `// installed \`align\`: it is ordinary checked-in TypeScript, compiled by the CLI's normal\n` +
  `// \`tsc\` build into dist alongside every other module, which IS published.\n` +
  `//\n` +
  `// Re-run \`node packages/cli/scripts/compile-upgrading-notes.mjs\` after editing UPGRADING.md.\n` +
  `// \`migration-notes-drift.test.ts\` fails if UPGRADING_MD_CONTENT_HASH below no longer matches\n` +
  `// the doc's current content — that is the drift detector, not a suggestion.\n` +
  `//\n` +
  `// Generated at: ${generatedAt}\n` +
  `import type { MigrationNote } from './types.js';\n` +
  `\n` +
  `/** sha256Hex (16-char) of UPGRADING.md's full text at compile time. */\n` +
  `export const UPGRADING_MD_CONTENT_HASH = ${tsStringLiteral(contentHash)};\n` +
  `\n` +
  `/** Migration notes compiled from UPGRADING.md, keyed by the exact version heading text\n` +
  ` * ("## <version>") it was compiled from. */\n` +
  `export const COMPILED_NOTES: Readonly<Record<string, readonly MigrationNote[]>> = ${renderNotesByVersion(notesByVersion)};\n`;

writeFileSync(outPath, fileContents, 'utf8');
console.log(`Wrote ${outPath}`);
console.log(`  versions: ${Object.keys(notesByVersion).join(', ')}`);
console.log(`  contentHash: ${contentHash}`);
