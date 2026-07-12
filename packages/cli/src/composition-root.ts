/**
 * `@align/cli` is the composition root (ARCHITECTURE.md §5): the only package that imports a
 * concrete `LanguagePlugin` and registers it. Core never imports `plugin-typescript` directly.
 */
import { GateOrchestrator, InMemoryBaselineStore, StaticPluginRegistry, type BaselineEntry, type RulesetIR } from '@align/core';
import { TypeScriptPlugin } from '@align/plugin-typescript';

export function createOrchestrator(ruleset: RulesetIR, baselineEntries: readonly BaselineEntry[]): {
  readonly orchestrator: GateOrchestrator;
  readonly baselineStore: InMemoryBaselineStore;
} {
  const registry = new StaticPluginRegistry([new TypeScriptPlugin()]);
  const baselineStore = new InMemoryBaselineStore(baselineEntries);
  const orchestrator = new GateOrchestrator(registry, ruleset, baselineStore);
  return { orchestrator, baselineStore };
}
