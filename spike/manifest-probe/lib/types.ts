// Shared types for the manifest-security probe (spike, throwaway).

export interface RepoTarget {
  /** Short id used in report tables. */
  id: string;
  /** Absolute path to the repo root (where pnpm-workspace.yaml / package.json lives). */
  root: string;
  /** Whether this repo has usable git history for the real baseline-diff rule. */
  gitUsable: boolean;
}

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** One workspace member as recorded in pnpm-lock.yaml's `importers:` map. */
export interface LockImporterDep {
  specifier: string;
  version: string;
}

export interface LockImporter {
  dependencies?: Record<string, LockImporterDep>;
  devDependencies?: Record<string, LockImporterDep>;
  optionalDependencies?: Record<string, LockImporterDep>;
}

export interface LockPackageEntry {
  resolution?: {
    integrity?: string;
    tarball?: string;
  };
}

export interface PnpmLockfile {
  lockfileVersion?: string;
  importers?: Record<string, LockImporter>;
  packages?: Record<string, LockPackageEntry>;
}

/** A single rule finding, uniform shape so the report generator can render any rule. */
export interface Finding {
  repo: string;
  location: string;
  detail: string;
  extra?: Record<string, unknown>;
}

export interface RuleResult {
  ruleId: string;
  repo: string;
  wallTimeMs: number;
  count: number;
  findings: Finding[];
  notes: string[];
}
