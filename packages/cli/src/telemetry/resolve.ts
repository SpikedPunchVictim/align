/**
 * `ALIGN_TELEMETRY=1` (env) OR `telemetry: true` (align.config.ts) OR `--telemetry` (flag)
 * enables telemetry; `--no-telemetry` overrides ALL of them. OFF by default
 * (IMPLEMENTATION_PLAN.md's telemetry Design Reserve entry).
 *
 * Split into two steps because the flag/env precedence is decidable before `align.config.ts` is
 * ever loaded (and `align check --untrusted` never loads it at all, ADR 014) while the config-file
 * toggle only exists once a command has called `loadConfig`. `resolveTelemetryPreConfig` returns
 * `undefined` exactly when the decision must defer to `config.telemetry`.
 */
export interface TelemetryCliFlags {
  /** `--telemetry` / `--no-telemetry`, straight from commander's `opts.telemetry` — always passed
   * explicitly (not `?:`) so a call site's `{ telemetry: opts.telemetry }` never trips
   * `exactOptionalPropertyTypes` just because commander's own type is `boolean | undefined`. */
  readonly telemetry: boolean | undefined;
}

export function resolveTelemetryPreConfig(flags: TelemetryCliFlags, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  // Commander's negatable-option pairing (`--telemetry` / `--no-telemetry` sharing one `telemetry`
  // property) already collapses "--no-telemetry was passed" down to `flags.telemetry === false` —
  // that's the one case that must win over everything else, checked first.
  if (flags.telemetry === false) return false;
  if (flags.telemetry === true) return true;
  if (env['ALIGN_TELEMETRY'] === '1') return true;
  return undefined;
}

export function resolveTelemetryEnabled(preConfig: boolean | undefined, configTelemetry: boolean | undefined): boolean {
  if (preConfig !== undefined) return preConfig;
  return configTelemetry === true;
}
