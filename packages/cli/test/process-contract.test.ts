import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/program.js';
import { commanderExitCode, installProcessContract } from '../src/process-contract.js';

/**
 * LEDGER **D026** — the contract align owes the SHELL, as distinct from the one it owes the
 * repository.
 *
 * Found by running a generic CLI best-practices checklist against a mature CLI, which is the part
 * worth remembering: 1445 unit tests and 23 integration scenarios drive real binaries, and every one
 * of them reads stdout to completion. Nothing this project owns had ever pointed a closing pipe at
 * align, because every instrument here was built to ask whether align's ANSWERS are right.
 *
 * **What these tests can and cannot reach.** align's own ruleset restricts `node:child_process` to
 * the audited git rails, so no test in this package may spawn the binary — which is exactly why
 * `installProcessContract` takes its streams as arguments. These tests therefore pin the guard's
 * LOGIC and the fact that it gets installed; the end-to-end behaviour was measured by hand against
 * the built binary, before and after:
 *
 *     before:  align skill --topic authoring | (exec true)   → 1188 bytes of Node internals
 *              node:events:487  throw er; // Unhandled 'error' event  /  Error: write EPIPE
 *     after:   same command                                  → 0 bytes
 *     before:  align check --nonsuch → exit 1 (= `check`'s RED verdict)
 *     after:   align check --nonsuch → exit 2; --help/--version/subcommand --help still 0
 *
 * Saying that plainly is better than implying the automated tests cover it.
 */

afterEach(() => vi.restoreAllMocks());

/** A stand-in for `process.stdout` — real enough to carry an `'error'` event, which is the entire
 * surface the guard attaches to. */
function fakeStream(): NodeJS.WriteStream {
  return new PassThrough() as unknown as NodeJS.WriteStream;
}

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

describe('a reader that closes the pipe is not an align failure', () => {
  it('swallows EPIPE on stdout instead of letting it become an unhandled error event', () => {
    const stdout = fakeStream();
    installProcessContract(stdout, fakeStream());

    // Without a listener this emit throws — that IS the defect, and it is what `node:events` does
    // with an unhandled `'error'`. The assertion is the absence of that throw.
    expect(() => stdout.emit('error', epipe())).not.toThrow();
  });

  it('leaves the exit code alone on EPIPE, so a red repository never reports success', () => {
    // The conventional EPIPE response is a quiet `process.exit(0)`, and it is wrong for align
    // specifically: the exit code carries a VERDICT, so exiting 0 on a broken pipe would report
    // success for a red repository — CLAUDE.md rule 6's severity-zero class arriving by the back
    // door. `runCheck` has already returned its code by the time output is written.
    const stdout = fakeStream();
    process.exitCode = 1;
    installProcessContract(stdout, fakeStream());

    stdout.emit('error', epipe());

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('does NOT swallow a real write failure — a full disk under `align check > out.json` is reportable', () => {
    // The guard must not become the defect shape this project keeps recording: an error handler that
    // silences everything. Only EPIPE means "the reader left"; ENOSPC means align lost the output.
    const stdout = fakeStream();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installProcessContract(stdout, fakeStream());

    stdout.emit('error', Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('could not write output'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('drops a stderr failure silently, because there is no channel left to report it through', () => {
    // Reporting a stderr write failure through `console.error` would recurse into the stream that
    // just failed. The only honest thing to do with it is nothing.
    const stderrStream = fakeStream();
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installProcessContract(fakeStream(), stderrStream);

    expect(() => stderrStream.emit('error', Object.assign(new Error('boom'), { code: 'ENOSPC' }))).not.toThrow();
    expect(reported).not.toHaveBeenCalled();
  });
});

describe('a usage error is not a red verdict (exit 2, not 1)', () => {
  // `align check` exits 1 for RED. Commander's default for a malformed command line is also 1, so a
  // typo in a CI script was indistinguishable from a repository that genuinely has violations —
  // which is the reason this mapping is worth more than convention-following.
  const USAGE: readonly { readonly why: string; readonly argv: readonly string[] }[] = [
    { why: 'an unknown option', argv: ['check', '--nonsuch'] },
    { why: 'an unknown command', argv: ['frobnicate'] },
    { why: 'a missing required argument', argv: ['explain'] },
    { why: 'an unknown option on a nested subcommand', argv: ['baseline', 'prune', '--nonsuch'] },
  ];

  for (const { why, argv } of USAGE) {
    it(`maps ${why} to exit 2`, async () => {
      // `exitOverride` (set in `buildProgram`) makes commander throw where it would otherwise call
      // `process.exit` itself — which is also what makes this testable in-process at all.
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const program = buildProgram();
      program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });

      const err = await program.parseAsync(['node', 'align', ...argv]).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(commanderExitCode(err)).toBe(2);
    });
  }

  it('keeps --help and --version at 0 — they are successful outcomes, not usage errors', async () => {
    const program = buildProgram();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });

    const err = await program.parseAsync(['node', 'align', '--help']).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(commanderExitCode(err)).toBe(0);
  });

  it('returns undefined for anything that is not a commander error, so index.ts rethrows it unchanged', () => {
    // The arm that keeps this mapping from swallowing real failures: a config-load crash must still
    // reach Node's uncaught-exception reporting rather than being reported as a usage mistake.
    expect(commanderExitCode(new Error('align.config.ts threw'))).toBeUndefined();
    expect(commanderExitCode(undefined)).toBeUndefined();
    expect(commanderExitCode({ code: 'ENOENT', exitCode: 1 })).toBeUndefined();
  });
});
