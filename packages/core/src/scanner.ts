import type { ComponentDefinitionIR } from './types/ir.js';
import type { ComponentName } from './types/branded.js';
import type { DependencyGraph } from './types/graph.js';

export interface ScanInput {
  readonly rootDir: string; // absolute filesystem path to the repo root being scanned
  readonly components: Readonly<Record<ComponentName, ComponentDefinitionIR>>;
  readonly excludes: readonly string[]; // configurable build-output excludes (ADR 004)
  // Task #25: a nested git checkout (worktree/submodule/vendored clone — anything with its own
  // `.git`, directory or file) is auto-excluded during the walk by default (it is never part of
  // THIS repo's architecture). Entries here opt specific checkouts back into the scan for a user
  // who genuinely considers one part of the project (e.g. a submodule) — matched against a
  // checkout's repo-relative path the SAME way `excludes` matches (`isExcludedPath`: exact path,
  // directory-prefix, or a full `globMatch` glob pattern) — not plain string-prefix comparison.
  // Optional so every pre-existing caller (tests, callers with no `align.config.ts` yet) keeps
  // working unchanged, same deviation shape as `excludes` opting out of a hard requirement.
  readonly includeNestedCheckouts?: readonly string[];
}

export interface Scanner {
  // Always a fresh, full scan in v1 — no partial/incremental mode exists to call by mistake
  // (ADR 005).
  scan(input: ScanInput): Promise<DependencyGraph>;
}
