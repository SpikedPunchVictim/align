/**
 * LEDGER D064 — an argument the user typed must never be silently discarded.
 *
 * Reported against `align build ARCHITECTURE.md`: the positional was accepted, dropped, and the run
 * proceeded against `docs/ARCHITECTURE-RULES.md`. In the reporter's repository that default did not
 * exist, so they got *"Doc not found: docs/ARCHITECTURE-RULES.md"* — an error naming a path they had
 * never typed, which reads as align failing to find THEIR file. In a repository where the default
 * DOES exist (align's own), it is worse: exit 0, a full build report, for a document nobody asked
 * about. That is the project's severity-zero shape in miniature — reporting success about the wrong
 * thing.
 *
 * Two layers are asserted here, and the first is the one that matters:
 *
 * 1. **No command anywhere accepts an argument it does not declare.** Walked from the live command
 *    tree rather than listed, so a command added tomorrow is covered the day it is added — the same
 *    reason `cli-inventory.ts` and `integration-all-projects.mjs` discover rather than enumerate.
 * 2. `align build <doc>` now MEANS the doc, because that is plainly what it looked like it meant.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Command, CommanderError } from 'commander';
import { commanderExitCode } from '../src/process-contract.js';
import { buildProgram } from '../src/program.js';
import { DEFAULT_DOC_PATH } from '../src/commands/build.js';

let tmpDir: string | undefined;
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** A repo align will accept as a root, with a doc at a NON-default path so "which doc did it read"
 * is answerable from the output alone. */
function makeRepo(docRelPath: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-excess-args-'));
  tmpDir = dest;
  fs.writeFileSync(
    path.join(dest, 'align.config.ts'),
    "import { defineProject } from '@spikedpunch/align-core/dsl';\nexport default defineProject({ components: { app: 'src/**' }, rules: () => [] });\n",
  );
  fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'src', 'index.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.dirname(path.join(dest, docRelPath)), { recursive: true });
  fs.writeFileSync(path.join(dest, docRelPath), '# Rules\n\nNo rules here.\n');
  return dest;
}

/** Every command in the tree, including nested subcommands (`baseline accept`, `agent run`). */
function allCommands(cmd: Command): Command[] {
  return cmd.commands.flatMap((c) => [c, ...allCommands(c)]);
}

describe('no command silently discards an argument (LEDGER D064)', () => {
  it('every command in the live tree refuses excess positional arguments', () => {
    // Discovered from `buildProgram()`, not listed: the defect was one command accepting an
    // undeclared argument, so a hand-written list of commands to check would have the same gap the
    // defect had. commander 12 defaults `allowExcessArguments` to TRUE, which is why this needed
    // saying at all.
    const program = buildProgram();
    const permissive = [program, ...allCommands(program)].filter(
      // `_allowExcessArguments` is commander's own private field; there is no public getter, and
      // asserting on the behaviour of ~20 commands one by one would be slower and no more true.
      (c) => (c as unknown as { _allowExcessArguments: boolean })._allowExcessArguments,
    );
    expect(permissive.map((c) => c.name())).toEqual([]);
  });

  it('`align build <doc>` reads THAT doc, not the default', async () => {
    const repo = makeRepo('ARCHITECTURE.md');
    process.chdir(repo);
    const said: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void said.push(args.map(String).join(' '));
    try {
      await buildProgram().parseAsync(['node', 'align', 'build', 'ARCHITECTURE.md']);
    } finally {
      console.log = log;
    }
    const output = said.join('\n');
    expect(output).toContain('ARCHITECTURE.md');
    expect(output).not.toContain(DEFAULT_DOC_PATH);
  });

  it('`align build` with no argument still reads the default doc', async () => {
    const repo = makeRepo(DEFAULT_DOC_PATH);
    process.chdir(repo);
    const said: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void said.push(args.map(String).join(' '));
    try {
      await buildProgram().parseAsync(['node', 'align', 'build']);
    } finally {
      console.log = log;
    }
    expect(said.join('\n')).toContain(DEFAULT_DOC_PATH);
  });

  it('`align build <doc> --doc <other>` refuses, and refuses as a USAGE error (exit 2)', async () => {
    const repo = makeRepo('ARCHITECTURE.md');
    process.chdir(repo);
    const err = console.error;
    console.error = () => {};
    try {
      await buildProgram().parseAsync(['node', 'align', 'build', 'ARCHITECTURE.md', '--doc', 'other.md']);
      expect.fail('expected a refusal');
    } catch (e) {
      expect((e as Error).message).toMatch(/both/i);
      // Asserting the EXIT CODE, not merely that something was thrown. The first version of this
      // fix threw a CommanderError with a custom `align.*` code; `commanderExitCode` only maps
      // codes prefixed `commander.`, so the binary printed a raw stack trace while a
      // `rejects.toThrow(/both/i)` assertion passed. A test that stops at "it threw" cannot see
      // the difference between a handled usage error and an unhandled crash.
      expect(commanderExitCode(e)).toBe(2);
    } finally {
      console.error = err;
    }
  });

  it('a stray argument to a command that takes none is a usage error, not a silent no-op', async () => {
    const repo = makeRepo(DEFAULT_DOC_PATH);
    process.chdir(repo);
    const err = console.error;
    console.error = () => {};
    try {
      await buildProgram().parseAsync(['node', 'align', 'doctor', 'oops']);
      expect.fail('expected a CommanderError');
    } catch (e) {
      // D026's contract: commander throws (exitOverride) and `index.ts` maps usage errors to 2.
      expect(e).toBeInstanceOf(CommanderError);
      expect((e as CommanderError).code).toBe('commander.excessArguments');
      expect(commanderExitCode(e)).toBe(2);
    } finally {
      console.error = err;
    }
  });
});
