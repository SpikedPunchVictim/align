/**
 * CLI command inventory for `align skill` — walks a real `commander` `Command` tree instead of
 * hand-maintaining a second list, so a command added to/removed from `program.ts` shows up here
 * automatically.
 *
 * Takes the `Command` as a parameter rather than importing `buildProgram` from `../program.js`
 * itself: `program.ts` registers the `skill` command (which imports this module transitively via
 * `render.ts`), so a static import back to `program.ts` here would close an
 * `arch.no-cycles`-violating cycle — align's own dogfood ruleset caught exactly this shape when it
 * was first wired up. `program.ts`'s `skill` command action passes its own already-built `program`
 * closure variable in; callers outside the CLI action (e.g. tests) build one via `buildProgram()`
 * and pass it in the same way.
 */
import type { Command } from 'commander';

function renderCommand(cmd: Command, pathPrefix: string, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const usage = cmd.usage();
  const fullPath = `${pathPrefix} ${cmd.name()}`.trim();
  const description = cmd.description();
  const lines = [`${indent}- \`align ${fullPath}${usage.length > 0 ? ` ${usage}` : ''}\`${description.length > 0 ? ` — ${description}` : ''}`];
  for (const sub of cmd.commands) lines.push(...renderCommand(sub, fullPath, depth + 1));
  return lines;
}

export function renderCliInventorySection(program: Command): string {
  const lines: string[] = [];
  for (const cmd of program.commands) lines.push(...renderCommand(cmd, '', 0));
  return lines.join('\n');
}
