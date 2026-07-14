/**
 * Pure argv construction for invoking the freshly-installed local `align` binary. `passthrough`
 * carries ONLY the flags create-align forwards to init (`--accept-existing`, `--greenfield`,
 * `--yes`, ...); the `init` subcommand is prepended HERE.
 *
 * Regression guard: create-align 0.1.0 shipped running bare `align <flags>` with the subcommand
 * missing, so `init` never executed (the args got parsed as unknown top-level align options). The
 * effects fake couldn't catch it — it records the intended call rather than building the real argv —
 * so the subcommand lives in this pure, unit-tested function instead of inline in `nodeEffects.ts`.
 */
export function alignInitArgv(passthrough: readonly string[]): readonly string[] {
  return ['init', ...passthrough];
}
