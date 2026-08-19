/**
 * `@spikedpunch/align-cli` is the composition root (ARCHITECTURE.md §5): the only package that imports a
 * concrete `LanguagePlugin` and registers it. Core never imports `plugin-typescript` directly.
 */
import {
  GateOrchestrator,
  InMemoryBaselineStore,
  StaticPluginRegistry,
  type BaselineEntry,
  type HostPredicateRegistry,
  type RulesetIR,
  type ScanHistoryProbe,
} from '@spikedpunch/align-core';
import { NodeManifestScanner, TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { createFileExistenceProbe } from './file-existence.js';

/** `hostPredicates` defaults to empty so every existing caller keeps working unchanged; a real
 * `align.config.ts` with a `hostRules` export flows its extracted registry (`config.ts`'s
 * `LoadedConfig.hostRules`) in here — this is the one place align's CLI wires the config-side
 * predicate functions into core's evaluator (docs/proposals/rule-expansion-evaluation.md §B.0). */
export function createOrchestrator(
  /** Repo root, absolute. Required since ADR 028 Stage 2: the baseline store needs a
   * `FileExistenceProbe`, the probe resolves repo-relative entry paths against this root, and core
   * cannot build one itself (no `node:fs` under `core/src`, ever). Threaded as a parameter rather
   * than read from `process.cwd()` so a caller operating on a directory other than the process cwd —
   * `init`, every test, the MCP server — cannot silently probe the wrong tree. */
  rootDir: string,
  ruleset: RulesetIR,
  baselineEntries: readonly BaselineEntry[],
  hostPredicates: HostPredicateRegistry = new Map(),
  /**
   * ADR 029 §6 — the temporal reference `InMemoryBaselineStore.applyMoves` consults before it
   * transfers a human's acceptance onto another file (LEDGER D015).
   *
   * REQUIRED and positioned AFTER a parameter that has a default, deliberately: `hostPredicates`
   * could keep its default because forgetting it costs a caller nothing but host rules, while
   * forgetting this one would silently reopen a severity-zero forged transfer. A defaulted parameter
   * followed by a required one is legal, but the default stops being reachable — so every caller now
   * states both, which is the point (all eight already passed `hostRules` explicitly, so this is not
   * a silent behaviour change for any of them).
   * `openScanHistory` (`scan-history.ts`) builds the real one; `noScanHistory()` is the honest answer
   * for a caller that has no repository to read it from.
   */
  scanHistory: ScanHistoryProbe,
): {
  readonly orchestrator: GateOrchestrator;
  readonly baselineStore: InMemoryBaselineStore;
} {
  const registry = new StaticPluginRegistry([new TypeScriptPlugin()]);
  const baselineStore = new InMemoryBaselineStore(baselineEntries, createFileExistenceProbe(rootDir), scanHistory);
  const manifestScanner = new NodeManifestScanner();
  const orchestrator = new GateOrchestrator(registry, ruleset, baselineStore, hostPredicates, manifestScanner);
  return { orchestrator, baselineStore };
}
