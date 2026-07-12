import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RulesetIR } from '@align/core';

export interface LoadedConfig {
  readonly ruleset: RulesetIR;
  // Not part of docs/core-interfaces.md's RulesetIR (excludes are a scan-time concern, not a
  // rule-evaluation concern, so they don't belong in the portable IR) — read from an optional
  // named `excludes` export in align.config.ts instead of widening defineProject's documented
  // return type. Deviation noted in the Stage 1 final report.
  readonly excludes: readonly string[];
}

export const CONFIG_FILENAME = 'align.config.ts';

/**
 * Loads `align.config.ts` from the repo root. Node 22+ strips TypeScript types natively on
 * dynamic import of a `.ts` file (verified: no `tsx`/`jiti` dependency needed for erasable
 * syntax) — align.config.ts is restricted to erasable TS (interfaces, type annotations; no
 * enums/parameter-properties) precisely so this keeps working without a build step.
 */
export async function loadConfig(rootDir: string): Promise<LoadedConfig> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  const mod = (await import(pathToFileURL(configPath).href)) as {
    default?: RulesetIR;
    excludes?: readonly string[];
  };
  if (mod.default === undefined) {
    throw new Error(`${CONFIG_FILENAME} must have a default export (the result of defineProject(...)).`);
  }
  return { ruleset: mod.default, excludes: mod.excludes ?? [] };
}
