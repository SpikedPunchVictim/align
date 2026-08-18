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
  // ADR 019 Mode 2 (the ungoverned-edge gap report, docs/adr/proposals/deep-import-provenance/reconciled-build-order.md #3):
  // explicit, human-declared composition-root component names (e.g. kluster's catch-all `api`,
  // which legitimately depends on every sub-layer) — excluded as a gap-report edge SOURCE so a
  // deliberate catch-all's expected fan-out isn't reported as noise. Same deviation shape as
  // `excludes`/`hostRules`/`telemetry`: this is an advisory-computation input, not a
  // rule-evaluation concern, so it doesn't belong in the portable `RulesetIR` — and ADR 019's
  // Precision-critical section explicitly rejects inferring this from a fan-out/glob-breadth
  // heuristic, so there is no other way to populate it. Read from an optional named
  // `compositionRoots` export; `[]` when absent.
  readonly compositionRoots: readonly string[];
  // ADR 020 (the deep-import convention check, `doctor`-advisory-only, no rule kind): explicit,
  // human-declared allowlist entries suppressing known-public deep-import conventions specific to
  // this repo's dependencies, on top of the built-in seed (`typescript/lib/*`, `mocha/lib/*` --
  // the measured vendor-convention FP class, `deep-imports.ts`'s `DEFAULT_ALLOWLIST`). Same
  // deviation shape as `excludes`/`hostRules`/`telemetry`/`compositionRoots`: an
  // advisory-computation input, not a rule-evaluation concern, so it doesn't belong in the
  // portable `RulesetIR`. Read from an optional named `knownPublicDeepImports` export; `[]` when
  // absent (the built-in seed still applies -- this list only ADDS to it, never replaces it).
  readonly knownPublicDeepImports: readonly string[];
  // Task #25 (auto-exclude nested git checkouts, visibly): same deviation shape as `excludes` — a
  // scan-time concern, not a rule-evaluation concern, so it doesn't belong in the portable
  // `RulesetIR`. Entries a human explicitly opts back into the scan despite carrying their own
  // `.git` (a submodule they consider part of the project) — matched the same way `excludes`
  // matches (exact path, directory-prefix, or glob pattern), not plain string-prefix comparison;
  // everything else with its own `.git` is auto-excluded by default. Read from an optional named
  // `includeNestedCheckouts` export; `[]` when absent.
  readonly includeNestedCheckouts: readonly string[];
  // ADR 006:40-43 / ADR 024: the single gate over every MCP-reachable write to
  // `.align/baseline.json` — today that's `align_propose_rules`'s `accept_new_into_baseline`
  // (`mcp/server.ts`). Default `false` (an agent cannot grant itself amnesty from a rule it is
  // failing); a human opts in per-project by adding `export const allowBaselineFromMcp = true;` to
  // align.config.ts — no MCP tool can set this, only a human editing the repo config can. Same
  // deviation shape as `excludes`/`hostRules`/`telemetry`/`compositionRoots`/
  // `knownPublicDeepImports`: an MCP-authorization concern, not a rule-evaluation concern, so it
  // doesn't belong in the portable `RulesetIR`. Unlike those siblings this is never optional at the
  // `LoadedConfig` boundary — there is exactly one source (this config export, no CLI flag/env var
  // precedence chain the way `telemetry` has), so "absent" is resolved to its default (`false`)
  // right here rather than carried as `undefined` for every caller to re-default.
  readonly allowBaselineFromMcp: boolean;
}

/** Validates an optional `string[]` sibling export (`excludes`/`compositionRoots`/
 * `knownPublicDeepImports`). These bypass zod — they're not part of the portable IR (see
 * `LoadedConfig`) — so a malformed value (a bare string, a number, a non-array) would otherwise
 * surface as a file-less `TypeError` deep in a consumer's `.map`/spread (e.g. `doctor.ts`'s
 * `compositionRoots.map`), which crashes `align doctor` — a command whose contract is to ALWAYS
 * exit 0. Fail fast HERE with a descriptive, actionable message; the doctor catch turns it into a
 * `config-error` advisory (exit 0), and `check` reports a clean config error instead of a raw trace. */
function readStringArrayExport(value: unknown, exportName: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    const got = Array.isArray(value) ? 'an array with non-string entries' : typeof value;
    throw new Error(`\`${exportName}\` in ${CONFIG_FILENAME} must be a string[] — got ${got}.`);
  }
  return value;
}

/** Same fail-fast discipline as `readStringArrayExport`, for the one boolean-shaped sibling export
 * (`allowBaselineFromMcp`) — this one is security-relevant (it authorizes an MCP-reachable
 * `.align/baseline.json` write, ADR 024), so a malformed value must be a loud config-load error,
 * never a value silently coerced to truthy/falsy. `undefined` (the export is absent) resolves to
 * the documented default, `false`. */
function readBooleanExport(value: unknown, exportName: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`\`${exportName}\` in ${CONFIG_FILENAME} must be a boolean — got ${typeof value}.`);
  }
  return value;
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

// Node's ESM module cache is keyed by resolved URL, so re-importing the SAME `align.config.ts`
// path within one process would otherwise return the module instance from the FIRST import even
// after the file changes on disk. Harmless for the common case (one process per CLI invocation),
// but wrong for `align mcp` (a long-running process that can call `loadConfig` again after a user
// edits the file mid-session) and for a future `align upgrade` run that applies more than one
// config-mutating transform in sequence within the same process — the second transform's own
// `loadConfig` must see the first transform's write, not a stale pre-write snapshot. A per-process
// monotonic counter (not `Date.now()`, whose millisecond resolution is not fine enough to
// guarantee two calls in the same tick get distinct query strings) makes every call a genuine
// fresh import, matching ADR 005's "no stale cache to distrust" doctrine already established for
// scans.
let importCacheBuster = 0;

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
    compositionRoots?: readonly string[];
    knownPublicDeepImports?: readonly string[];
    includeNestedCheckouts?: readonly string[];
    allowBaselineFromMcp?: boolean;
  };
  try {
    importCacheBuster += 1;
    mod = (await import(`${pathToFileURL(configPath).href}?align-reload=${importCacheBuster}`)) as typeof mod;
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
  const excludes = readStringArrayExport(mod.excludes, 'excludes');
  const hostRules = toHostPredicateRegistry(mod.hostRules);
  const telemetry = mod.telemetry !== undefined ? { telemetry: mod.telemetry } : {};
  const compositionRoots = readStringArrayExport(mod.compositionRoots, 'compositionRoots');
  const knownPublicDeepImports = readStringArrayExport(mod.knownPublicDeepImports, 'knownPublicDeepImports');
  const includeNestedCheckouts = readStringArrayExport(mod.includeNestedCheckouts, 'includeNestedCheckouts');
  const allowBaselineFromMcp = readBooleanExport(mod.allowBaselineFromMcp, 'allowBaselineFromMcp');

  if (!includeGenerated) {
    return {
      ruleset: mod.default,
      excludes,
      hostRules,
      compositionRoots,
      knownPublicDeepImports,
      includeNestedCheckouts,
      allowBaselineFromMcp,
      ...telemetry,
    };
  }

  const generated = readGeneratedRules(rootDir);
  if (generated === undefined) {
    return {
      ruleset: mod.default,
      excludes,
      hostRules,
      compositionRoots,
      knownPublicDeepImports,
      includeNestedCheckouts,
      allowBaselineFromMcp,
      ...telemetry,
    };
  }

  const mergedRules = mergeGeneratedRules(mod.default.rules, generated.rules);
  return {
    ruleset: { ...mod.default, rules: [...mergedRules] },
    excludes,
    hostRules,
    compositionRoots,
    knownPublicDeepImports,
    includeNestedCheckouts,
    allowBaselineFromMcp,
    ...telemetry,
  };
}
