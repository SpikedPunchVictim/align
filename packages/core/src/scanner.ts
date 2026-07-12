import type { ComponentDefinitionIR } from './types/ir.js';
import type { ComponentName } from './types/branded.js';
import type { DependencyGraph } from './types/graph.js';

export interface ScanInput {
  readonly rootDir: string; // absolute filesystem path to the repo root being scanned
  readonly components: Readonly<Record<ComponentName, ComponentDefinitionIR>>;
  readonly excludes: readonly string[]; // configurable build-output excludes (ADR 004)
}

export interface Scanner {
  // Always a fresh, full scan in v1 — no partial/incremental mode exists to call by mistake
  // (ADR 005).
  scan(input: ScanInput): Promise<DependencyGraph>;
}
