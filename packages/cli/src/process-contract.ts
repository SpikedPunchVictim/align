/**
 * The contract align owes the SHELL, as distinct from the one it owes the repository.
 *
 * Everything else in this package is about whether align's ANSWERS are right — the gates, the
 * baseline, ADR 023's refusals, ADR 026's write-sets. None of it asks whether align behaves like a
 * well-formed UNIX process, and that gap is what LEDGER D026 records: 1445 unit tests and 23
 * integration scenarios drive real binaries, and every one of them reads stdout to completion, so no
 * instrument this project owns had ever pointed a closing pipe at align.
 *
 * Installed once, from `index.ts`, before any command runs.
 */

/**
 * A downstream reader that closed the pipe is not an align failure.
 *
 * **Measured before the fix** (D026): `align skill --topic authoring | (exec true)` produced 1188
 * bytes of Node internals on stderr — `node:events:487 throw er; // Unhandled 'error' event`,
 * `Error: write EPIPE` — because nothing was listening for `'error'` on the stdout stream. The
 * ordinary `| head -N` form did not reach it only because every payload align currently produces is
 * smaller than the pipe buffer (~64KB), so `head` drains them fully before exiting; a repository with
 * hundreds of violations reaches it through `check --json`.
 *
 * **What this deliberately does NOT do: force `process.exit(0)`.** That is the conventional EPIPE
 * response and it is wrong for align specifically, because align's exit code carries a VERDICT — a
 * quiet `exit(0)` on a broken pipe would report success for a red repository, which is CLAUDE.md
 * rule 6's severity-zero class arriving through the back door. Swallowing the error is enough: the
 * run continues, `runCheck` returns its real code, and `program.ts` sets it.
 *
 * **Nothing on disk is at risk from a broken pipe, and that is checked rather than assumed.**
 * `runCheck` performs every persistence step — `persistMovedBaseline` (check.ts:128),
 * `persistScanObservation` (check.ts:159) — BEFORE the first byte of output is written (the JSON
 * path at check.ts:354, the human path from check.ts:390). So an EPIPE during printing cannot lose a
 * write. If that ordering is ever inverted, this comment is wrong and the guard needs to become an
 * early exit instead.
 */
function ignoreBrokenPipe(stream: NodeJS.WriteStream, canReport: boolean): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    // Any other write failure is real (a full disk under `align check > out.json`, a revoked
    // redirect) and must not be silently swallowed — that would be this project's most-repeated
    // defect shape wearing an error handler. Reported on the OTHER stream where one exists; a
    // failing stderr has no channel left to complain through, so it is dropped rather than
    // recursing.
    if (!canReport) return;
    console.error(`align: could not write output (${err.message}).`);
    process.exitCode = 1;
  });
}

/**
 * Commander exits `1` for a usage error, and for align that collides with something meaningful:
 * **`align check` exits 1 for a RED verdict.** So `align check --nonesuch` — a typo in a CI script —
 * is today indistinguishable from a repository that genuinely has violations, and the script's
 * author sees a plausible red instead of "you misspelled a flag". Usage errors move to `2`.
 *
 * Returns the code to use, or `undefined` if `err` is not a commander error at all (the caller
 * rethrows those unchanged). `--help` and `--version` also arrive here under `exitOverride`, with
 * `exitCode: 0`; they are successful outcomes and keep it.
 */
export function commanderExitCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { readonly code?: unknown; readonly exitCode?: unknown };
  if (typeof candidate.code !== 'string' || !candidate.code.startsWith('commander.')) return undefined;
  const exitCode = typeof candidate.exitCode === 'number' ? candidate.exitCode : 1;
  // Help and version are not failures. Everything else commander throws is the user getting the
  // command line wrong, which is exactly what 2 means.
  return exitCode === 0 ? 0 : 2;
}

/**
 * Installs the process-level contract. Idempotent in practice (called once from `index.ts`), and
 * deliberately NOT including a `SIGINT` handler.
 *
 * **The SIGINT non-fix is the most useful thing in this file.** D026 first recorded "no SIGINT
 * handler, so Ctrl+C exits 0/1 rather than 130" as a defect. Measured at the fix, that is false:
 * Node with no `SIGINT` listener restores the signal's default disposition and the shell already
 * observes 130. Adding a handler is what would break it — a listener that sets `process.exitCode`
 * without calling `process.exit` SUPPRESSES the default kill, so Ctrl+C would stop interrupting
 * align at all. The correct implementation of that rule is the empty one, and it is written down
 * here so nobody "fixes" it later.
 */
export function installProcessContract(
  /** The two streams to guard. REQUIRED rather than defaulted to `process.stdout`/`process.stderr`,
   * for the same reason every probe in this codebase is injected: align's own ruleset restricts
   * `node:child_process` to the audited git rails (`custom.host:no-child-process-outside-git-rails`),
   * so a test cannot spawn the real binary to observe a broken pipe — it has to hand this function a
   * stream it controls. The entry point stating which streams it guards is the honest version of that
   * seam, not a workaround for it. */
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): void {
  ignoreBrokenPipe(stdout, true);
  ignoreBrokenPipe(stderr, false);
}
