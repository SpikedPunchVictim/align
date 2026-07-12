/**
 * Probe 4 — second repo (n=2): scan an external pnpm monorepo the spike was NOT built
 * against, with components auto-derived from workspace packages (no hand-picking).
 *
 * No `pnpm install` is run in the target: workspace cross-package imports therefore
 * cannot resolve through node_modules symlinks. We account for that honestly by
 * classifying unresolved specifiers against the workspace package-name list.
 *
 * Usage: tsx src/probe-external.ts /abs/path/to/repo [scanRoot=packages]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluateRule } from './rules.js';
import { scanRepo } from './scanner.js';

const repoRoot = process.argv[2];
if (repoRoot === undefined) throw new Error('usage: probe-external.ts <repoRoot> [scanRoot]');
const scanRoot = process.argv[3] ?? 'packages';

// --- Auto-derive components: every workspace package = one component (dir prefix). ---
interface WorkspacePackage {
  readonly name: string;
  readonly dirPrefix: string; // repo-relative, trailing slash
}

function discoverWorkspacePackages(root: string): WorkspacePackage[] {
  const workspaceYaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...workspaceYaml.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)]
    .map((m) => m[1] ?? '')
    .filter((g) => g.length > 0 && !g.includes(':'));

  const packages: WorkspacePackage[] = [];
  const addIfPackage = (absDir: string): void => {
    const pkgJson = path.join(absDir, 'package.json');
    if (!fs.existsSync(pkgJson)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { name?: string };
      if (parsed.name === undefined) return;
      const rel = path.relative(root, absDir).split(path.sep).join('/');
      packages.push({ name: parsed.name, dirPrefix: `${rel}/` });
    } catch {
      /* unparseable package.json — skip */
    }
  };
  const expand = (absBase: string, depthLeft: number): void => {
    if (depthLeft < 0) return;
    addIfPackage(absBase);
    if (depthLeft === 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absBase, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules') expand(path.join(absBase, e.name), depthLeft - 1);
    }
  };
  for (const glob of globs) {
    const staticBase = glob.split('*')[0]?.replace(/\/$/, '') ?? '';
    const depth = glob.includes('**') ? 3 : (glob.match(/\*/g) ?? []).length > 0 ? 1 : 0;
    expand(path.join(root, staticBase), depth);
  }
  // Deduplicate by dirPrefix; prefer deepest (most specific) prefixes at classify time.
  const byPrefix = new Map(packages.map((p) => [p.dirPrefix, p]));
  return [...byPrefix.values()].sort((a, b) => b.dirPrefix.length - a.dirPrefix.length);
}

const started = performance.now();
const workspacePackages = discoverWorkspacePackages(repoRoot);
const discoverMs = Math.round(performance.now() - started);
const workspaceNames = new Set(workspacePackages.map((p) => p.name));

const classify = (repoRelPath: string): string | undefined =>
  workspacePackages.find((p) => repoRelPath.startsWith(p.dirPrefix))?.name;

// --- Scan ---
const { graph, stats } = scanRepo(repoRoot, [scanRoot]);

// --- Honest uncertainty accounting: uninstalled workspace deps vs everything else ---
let uninstalledWorkspace = 0;
let uninstalledExternalLooking = 0;
let relativeOrAlias = 0;
const externalUnresolvedSamples = new Map<string, number>();
for (const u of graph.uncertain) {
  if (u.reason !== 'unresolvable-specifier') continue;
  const spec = u.specifierPreview ?? '';
  const base = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] ?? spec;
  if (workspaceNames.has(base)) uninstalledWorkspace += 1;
  else if (spec.startsWith('.') || spec.startsWith('#') || spec.startsWith('@/')) relativeOrAlias += 1;
  else {
    uninstalledExternalLooking += 1;
    externalUnresolvedSamples.set(base, (externalUnresolvedSamples.get(base) ?? 0) + 1);
  }
}

// --- Component fit ---
let mapped = 0;
const unmappedSamples: string[] = [];
for (const node of graph.nodes.keys()) {
  if (classify(node) !== undefined) mapped += 1;
  else if (unmappedSamples.length < 15) unmappedSamples.push(node);
}

// --- Cycles (runtime edge kinds, repo-wide over scanned nodes) ---
const cycleStarted = performance.now();
const cycles = evaluateRule(graph, {
  id: 'probe-external-cycles',
  kind: 'no-cycles',
  scope: 'repo',
  edgeKinds: ['import', 'reexport', 'dynamic'],
  rationale: 'probe',
});
const cycleMs = Math.round(performance.now() - cycleStarted);

console.log(JSON.stringify({
  repo: repoRoot,
  workspacePackagesDiscovered: workspacePackages.length,
  discoverMs,
  stats,
  uncertainty: {
    total: graph.uncertain.length,
    nonLiteralDynamic: graph.uncertain.filter((u) => u.reason === 'non-literal-dynamic-specifier').length,
    unresolvable: {
      uninstalledWorkspacePackage: uninstalledWorkspace,
      externalLookingUninstalled: uninstalledExternalLooking,
      relativeOrAlias,
      topExternalUnresolved: [...externalUnresolvedSamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    },
    filesAffectedPct: Math.round((stats.uncertainFileCount / stats.filesScanned) * 1000) / 10,
  },
  componentFit: {
    filesMapped: mapped,
    filesUnmapped: graph.nodes.size - mapped,
    unmappedSamples,
  },
  cycles: {
    count: cycles.length,
    evalMs: cycleMs,
    chains: cycles.slice(0, 12).map((v) => (v.kind === 'no-cycles' ? v.chain : [])),
  },
}, null, 2));
