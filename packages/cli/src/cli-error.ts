/**
 * Shared "print a caught error as a one-line CLI message and exit non-zero" helper (bug hunt
 * 2026-08-03, BUG #14). Before this, `err instanceof Error ? err.message : String(err)` was
 * repeated 19 times across 8 files in at least four incompatible shapes — `console.error` +
 * `return 1` (several commands), `console.log` + `return 1` (one command, an inconsistency fixed
 * alongside this helper's introduction), a local `{ ok, code }` discriminated union
 * (`commands/baseline.ts`'s `tryReadBaseline`), an MCP content object, an advisory push
 * (`commands/doctor.ts`), and a swallow-to-`[]` (`telemetry/*`). Only the first family — a bare
 * "print and fail" catch with no other side effect — collapses onto this helper; the other shapes
 * exist because they genuinely do something different (a differently-typed return, a second
 * console sink, additional recorder/advisory calls) and must keep doing it. See CLAUDE.md's
 * "never silently swallow" doctrine: this helper always prints AND always returns a non-zero exit
 * code — it has no swallowing mode, on purpose, so it can never be misused into a false green.
 */

/** Formats `err` into `"<command>: <message>"`, unwrapping `Error#message` and falling back to
 * `String(err)` for a non-Error throw (the one normalization every existing catch already did,
 * just inconsistently placed). */
export function formatCliError(command: string, err: unknown): string {
  return `${command}: ${err instanceof Error ? err.message : String(err)}`;
}

/** Prints `formatCliError`'s message to stderr and returns `1` — the exit code every CLI command
 * in this codebase returns on failure (`process.exitCode = <returned number>`, `program.ts`).
 * Use at a command entry's top-level catch when the only job left is "report and fail"; a catch
 * that also needs to record telemetry, push an advisory, or return something other than a plain
 * exit code should keep its own shape instead of forcing itself through this one. */
export function reportCliError(command: string, err: unknown): number {
  console.error(formatCliError(command, err));
  return 1;
}
