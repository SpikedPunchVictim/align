import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeGeneratedRules, type HostPredicate, type HostPredicateRegistry, type RulesetIR } from '@spikedpunch/align-core';
import { readGeneratedRules } from './align-dir.js';
import { toAlignCoreMissingError } from './errors.js';

export interface LoadedConfig {
  readonly ruleset: RulesetIR;
  // Not part of docs/core-interfaces.md's RulesetIR (excludes are a scan-time concern, not a
  // rule-evaluation concern, so they don't belong in the portable IR) — read from an optional
  // named `excludes` export in align.config.ts instead of widening defineProject's documented
  // return type. Deviation noted in the Stage 1 final report.
  readonly excludes: readonly string[];
  // Same shape of deviation, for the same reason (ADR 002): `RulesetIR` is portable JSON, and
  // predicate functions can't survive that boundary. `hostRules` is a sibling named export
  // (`{ [hostRuleName]: HostPredicate }`), never passed through `defineProject`/zod — this is the
  // one place align.config.ts's function-valued export becomes the typed registry core's
  // `GateOrchestrator` and `groundFragment` actually consume (docs/proposals/rule-expansion-
  // evaluation.md §B.0).
  readonly hostRules: HostPredicateRegistry;
  // Same shape of deviation as `excludes`/`hostRules` above — `telemetry: true` (IMPLEMENTATION_PLAN.md's
  // telemetry Design Reserve entry) is a scan-time/CLI-behavior toggle, not a rule-evaluation
  // concern, so it doesn't belong in the portable `RulesetIR` either. Read from an optional named
  // `telemetry` export; `undefined` when absent (never defaulted here — `resolveTelemetryEnabled`,
  // `telemetry/resolve.ts`, treats "config didn't say" as "no" only after `--telemetry`/
  // `--no-telemetry`/`ALIGN_TELEMETRY` have all already been checked).
  readonly telemetry?: boolean;
}

function toHostPredicateRegistry(hostRules: Record<string, HostPredicate> | undefined): HostPredicateRegistry {
  return new Map(Object.entries(hostRules ?? {}));
}

export interface LoadConfigOptions {
  /** Merge `.align/generated-rules.json` into the loaded ruleset when present (ADR 011's
   * config-integration mechanism — see `@spikedpunch/align-core`'s `mergeGeneratedRules`). Defaults to `true`
   * so every existing surface (`check`, `doctor`, `mcp`) enforces doc-built rules automatically,
   * with zero required edits to `align.config.ts`. `align build`'s own dry-run pipeline passes
   * `false` to see the hand-authored ruleset in isolation, since it needs to diff the CURRENT
   * on-disk generated rules against a freshly PROPOSED set, not a set that's already merged in. */
  readonly includeGenerated?: boolean;
}

export const CONFIG_FILENAME = 'align.config.ts';

/**
 * Loads `align.config.ts` from the repo root. Node 22+ strips TypeScript types natively on
 * dynamic import of a `.ts` file (verified: no `tsx`/`jiti` dependency needed for erasable
 * syntax) — align.config.ts is restricted to erasable TS (interfaces, type annotations; no
 * enums/parameter-properties) precisely so this keeps working without a build step.
 *
 * ADR 011 config-integration mechanism: after loading the hand-authored ruleset, this merges in
 * `.align/generated-rules.json` when present (`mergeGeneratedRules`, `@spikedpunch/align-core/build`) — the
 * loader boundary was chosen over an explicit `withGeneratedRules()` call in every
 * `align.config.ts` (or `defineProject` doing its own fs I/O) as the least-magical option that
 * still requires zero human edits to the config file; see the Stage 3 final report.
 */
export async function loadConfig(rootDir: string, options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const includeGenerated = options.includeGenerated ?? true;
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  let mod: {
    default?: RulesetIR;
    excludes?: readonly string[];
    hostRules?: Record<string, HostPredicate>;
    telemetry?: boolean;
  };
  try {
    mod = (await import(pathToFileURL(configPath).href)) as typeof mod;
  } catch (err) {
    // A target repo that hasn't installed @spikedpunch/align-core as a local devDependency yet
    // (align.config.ts's own `import ... from '@spikedpunch/align-core/dsl'`) fails here with a
    // raw ERR_MODULE_NOT_FOUND — mapped to a friendly, actionable error covering
    // check/doctor/mcp/init (all funnel through this function). Any other import failure (a
    // genuine syntax error, an unrelated missing module) is rethrown unchanged, never swallowed.
    const mapped = toAlignCoreMissingError(err);
    throw mapped ?? err;
  }
  if (mod.default === undefined) {
    throw new Error(`${CONFIG_FILENAME} must have a default export (the result of defineProject(...)).`);
  }
  const excludes = mod.excludes ?? [];
  const hostRules = toHostPredicateRegistry(mod.hostRules);
  const telemetry = mod.telemetry !== undefined ? { telemetry: mod.telemetry } : {};

  if (!includeGenerated) return { ruleset: mod.default, excludes, hostRules, ...telemetry };

  const generated = readGeneratedRules(rootDir);
  if (generated === undefined) return { ruleset: mod.default, excludes, hostRules, ...telemetry };

  const mergedRules = mergeGeneratedRules(mod.default.rules, generated.rules);
  return { ruleset: { ...mod.default, rules: [...mergedRules] }, excludes, hostRules, ...telemetry };
}
