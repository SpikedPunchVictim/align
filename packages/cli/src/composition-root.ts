/**
 * `@align/cli` is the composition root (ARCHITECTURE.md §5): the only package that imports a
 * concrete `LanguagePlugin` and registers it. Core never imports `plugin-typescript` directly.
 */
import {
  GateOrchestrator,
  InMemoryBaselineStore,
  StaticPluginRegistry,
  type BaselineEntry,
  type HostPredicateRegistry,
  type RulesetIR,
} from '@align/core';
import { NodeManifestScanner, TypeScriptPlugin } from '@align/plugin-typescript';

/** `hostPredicates` defaults to empty so every existing caller keeps working unchanged; a real
 * `align.config.ts` with a `hostRules` export flows its extracted registry (`config.ts`'s
 * `LoadedConfig.hostRules`) in here — this is the one place align's CLI wires the config-side
 * predicate functions into core's evaluator (docs/proposals/rule-expansion-evaluation.md §B.0). */
export function createOrchestrator(
  ruleset: RulesetIR,
  baselineEntries: readonly BaselineEntry[],
  hostPredicates: HostPredicateRegistry = new Map(),
): {
  readonly orchestrator: GateOrchestrator;
  readonly baselineStore: InMemoryBaselineStore;
} {
  const registry = new StaticPluginRegistry([new TypeScriptPlugin()]);
  const baselineStore = new InMemoryBaselineStore(baselineEntries);
  const manifestScanner = new NodeManifestScanner();
  const orchestrator = new GateOrchestrator(registry, ruleset, baselineStore, hostPredicates, manifestScanner);
  return { orchestrator, baselineStore };
}
