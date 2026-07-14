/**
 * Manifest scan domain (ADR 013): a genuinely different input class from everything
 * `plugin-typescript`'s TS-source scanner produces (`DependencyGraph`) — package.json/pnpm-lock.yaml
 * text, not parsed TypeScript. Core defines only the shape and the injection seam
 * (`ManifestScanner`); the concrete pnpm/Node-ecosystem reader lives in `@spikedpunch/align-plugin-typescript`
 * (ADR 013's placement decision), wired in at the CLI composition root exactly like
 * `LanguagePlugin`/`TypeScriptPlugin` already is — core never imports plugin-typescript directly
 * (ARCHITECTURE.md §5).
 */
import type { RepoRelativePath } from './branded.js';

/** `optionalDependencies` is scanned (source-hygiene cares about any non-registry specifier
 * regardless of field) but deliberately excluded from `security.manifest.new-dependency`'s
 * name-level gating (ADR 013: runtime + dev only — an optional dep's absence/presence is a
 * different risk shape, out of scope for this promotion). `peerDependencies` is never collected at
 * all: it never resolves to an installable artifact of its own (ADR 004's precedent — align's
 * existing lockfile-drift probe rule hit exactly this false-positive class). */
export type ManifestDepField = 'dependencies' | 'devDependencies' | 'optionalDependencies';

export interface ManifestDependency {
  readonly name: string;
  /** The effective specifier: lockfile-resolved (`pnpm-lock.yaml` importer entry) when a lockfile
   * is present, else the raw `package.json` value. Lockfile resolution is what makes a
   * `catalog:`-managed dependency's real specifier visible (docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md Rule 1's
   * documented reason for reading the lockfile at all, not just package.json). */
  readonly specifier: string;
  readonly field: ManifestDepField;
  /** Best-effort 1-based line number of this dependency's raw-text declaration in `raw`, for
   * `Violation.range`/`snippet`. `undefined` when the raw text couldn't be located (should not
   * happen for well-formed JSON, but read-only survey posture never throws on it). */
  readonly line?: number;
}

export interface ManifestRecord {
  /** Repo-relative path to the declaring `package.json` (root or a workspace member). */
  readonly file: RepoRelativePath;
  /** Exact source text — the `Violation.snippet` extraction source (ADR 007: snippet is required,
   * never synthesized prose). */
  readonly raw: string;
  readonly dependencies: readonly ManifestDependency[];
}

export interface ManifestInventory {
  readonly manifests: readonly ManifestRecord[];
  /** Whether `pnpm-lock.yaml` was found and parsed — informational only in v1 (no rule currently
   * branches on it), kept on the inventory since a future lockfile-dependent rule (e.g. Rule 5's
   * registry-provenance check, rejected on evidence per ADR 013) would need it. */
  readonly lockfilePresent: boolean;
}

export const EMPTY_MANIFEST_INVENTORY: ManifestInventory = { manifests: [], lockfilePresent: false };

export interface ManifestScanOptions {
  readonly rootDir: string; // absolute filesystem path
  readonly excludes: readonly string[];
}

/** Injection seam (mirrors `Scanner`/`LanguagePlugin`, `scanner.ts`/`plugin/registry.ts`): core
 * only ever sees this interface. `GateOrchestrator` defaults to a no-op implementation returning
 * `EMPTY_MANIFEST_INVENTORY` so every existing caller/test that doesn't care about the security
 * gate keeps working unchanged (same default-injection convention as `hostPredicates`). */
export interface ManifestScanner {
  scan(options: ManifestScanOptions): Promise<ManifestInventory> | ManifestInventory;
}
