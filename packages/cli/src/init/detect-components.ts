import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadWorkspacePackages } from '@align/plugin-typescript';

export interface DetectedComponent {
  readonly name: string;
  readonly pattern: string; // glob selector, e.g. 'packages/core/**'
}

/**
 * Mechanical component auto-detection for `align init`. Groups by the *fixed (non-wildcard)
 * prefix* of each `pnpm-workspace.yaml` glob pattern rather than one component per package — a
 * generically-implementable heuristic that keeps the starter component count small without
 * requiring the hand-curated judgment calls the spike applied to kluster (documented limitation:
 * less semantically precise than a human-reviewed component map, but zero-config and directionally
 * correct for the common "packages/*, application/*" monorepo shape).
 */
export function detectComponents(rootDir: string): DetectedComponent[] {
  const wsPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(wsPath)) {
    return detectFromWorkspaceFile(rootDir);
  }
  const fromDirs = detectFromTopLevelPackageDirs(rootDir);
  if (fromDirs.length > 0) return fromDirs;
  return detectSinglePackage(rootDir);
}

function detectFromWorkspaceFile(rootDir: string): DetectedComponent[] {
  // Re-derive the raw glob pattern list the same way loadWorkspacePackages does, but we only
  // need the *patterns* here, not the resolved packages.
  const wsPath = path.join(rootDir, 'pnpm-workspace.yaml');
  const patterns = readWorkspacePatterns(wsPath);
  const prefixes = new Set<string>();
  for (const pattern of patterns) prefixes.add(fixedPrefix(pattern));

  const components = [...prefixes]
    .sort((a, b) => b.length - a.length) // longest/most-specific prefix classifies first
    .map((prefix) => ({ name: sanitizeName(lastSegment(prefix)), pattern: `${prefix}/**` }));

  return dedupeNames(components);
}

function readWorkspacePatterns(wsPath: string): string[] {
  try {
    // Lightweight, dependency-free read of the `packages:` list — avoids importing the `yaml`
    // package here too; a regex-free approach would need full YAML parsing, so we defer to a
    // minimal line-based reader sufficient for the simple list shape pnpm-workspace.yaml uses.
    const text = fs.readFileSync(wsPath, 'utf8');
    const lines = text.split('\n');
    const patterns: string[] = [];
    let inPackages = false;
    for (const line of lines) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = /^\s*-\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
        if (m?.[1] !== undefined) {
          patterns.push(m[1]);
          continue;
        }
        if (/^\S/.test(line)) break; // dedented to a new top-level key
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

function fixedPrefix(pattern: string): string {
  const segments = pattern.split('/');
  const idx = segments.findIndex((s) => s.includes('*'));
  const prefixSegments = idx === -1 ? segments : segments.slice(0, idx);
  return (prefixSegments.length > 0 ? prefixSegments.join('/') : segments[0]) || pattern;
}

function lastSegment(prefix: string): string {
  const segments = prefix.split('/');
  return segments[segments.length - 1] ?? prefix;
}

/** Component names double as `c.<name>` property accesses and unquoted object-literal keys in
 * the generated DSL (render-config.ts), so they must be valid JS identifiers — not just valid
 * against the IR's `^[A-Za-z][A-Za-z0-9_-]*$` ComponentName pattern, which permits hyphens that
 * `c.kluster-bt` would then parse as a subtraction expression. camelCase rather than hyphenate. */
function sanitizeName(raw: string): string {
  const stripped = raw.replace(/^@/, '');
  const camel = stripped
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join('');
  return /^[A-Za-z]/.test(camel) ? camel : `c${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

function dedupeNames(components: DetectedComponent[]): DetectedComponent[] {
  const seen = new Map<string, number>();
  return components.map((c) => {
    const count = seen.get(c.name) ?? 0;
    seen.set(c.name, count + 1);
    return count === 0 ? c : { ...c, name: `${c.name}-${count + 1}` };
  });
}

function detectFromTopLevelPackageDirs(rootDir: string): DetectedComponent[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const components: DetectedComponent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (fs.existsSync(path.join(rootDir, entry.name, 'package.json'))) {
      components.push({ name: sanitizeName(entry.name), pattern: `${entry.name}/**` });
    }
  }
  return dedupeNames(components);
}

function detectSinglePackage(rootDir: string): DetectedComponent[] {
  const hasSrc = fs.existsSync(path.join(rootDir, 'src'));
  return [{ name: 'app', pattern: hasSrc ? 'src/**' : '**' }];
}

// Re-exported for callers that already have the resolved workspace package list handy (e.g. the
// layer-suggestion step, which needs both the grouping above and per-package names for edges).
export { loadWorkspacePackages };
