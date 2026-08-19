import { toComponentName, toRepoRelativePath, toRuleId, toViolationId, type CheckRun, type DependencyGraph, type DependencyGraphEdge, type DependencyGraphNode, type EdgeKind, type GateResult, type Violation } from '@spikedpunch/align-core';

export function node(file: string, component: string, exports: string[] = [], loc = 10, snippet?: string): DependencyGraphNode {
  return { file: toRepoRelativePath(file), component: toComponentName(component), loc, exports, snippet: snippet ?? `// ${file}` };
}

export function edge(
  from: string,
  to: string,
  opts: { specifier?: string; line?: number; kind?: EdgeKind; snippet?: string } = {},
): DependencyGraphEdge {
  const specifier = opts.specifier ?? to;
  return {
    from: toRepoRelativePath(from),
    to: toRepoRelativePath(to),
    specifier,
    line: opts.line ?? 1,
    kind: opts.kind ?? 'import',
    snippet: opts.snippet ?? `import x from '${specifier}';`,
  };
}

export function graph(nodes: DependencyGraphNode[], edges: DependencyGraphEdge[]): DependencyGraph {
  return { nodes, edges, externalNodes: [], externalEdges: [], uncertain: [], blindSpots: [], scannedAt: Date.now() };
}

export function violation(
  overrides: Omit<Partial<Violation>, 'id' | 'ruleId' | 'file'> & { id: string; ruleId: string; file: string },
): Violation {
  return {
    category: 'architecture',
    severity: 'error',
    range: overrides.range ?? { startLine: 1, endLine: 1 },
    snippet: overrides.snippet ?? 'import x from "./y.js";',
    fixHint: overrides.fixHint ?? { code: 'manual-review' },
    kind: 'no-dependency',
    fromFile: toRepoRelativePath(overrides.file),
    toFile: toRepoRelativePath('other.ts'),
    fromComponent: toComponentName('a'),
    toComponent: toComponentName('b'),
    specifier: './other.js',
    line: 1,
    ...overrides,
    // Re-applied after the spread: `overrides.id`/`ruleId`/`file` are plain strings (that's the
    // whole point of this helper — callers pass raw ids/paths and get them branded). Spreading
    // `overrides` last used to silently overwrite these branded values with the raw ones
    // (TS2783), which for `file` also meant losing `toRepoRelativePath`'s backslash
    // normalization at runtime, not just the type brand.
    id: toViolationId(overrides.id),
    ruleId: toRuleId(overrides.ruleId),
    file: toRepoRelativePath(overrides.file),
  } as Violation;
}

export function checkRun(violations: readonly Violation[], overrides: Partial<CheckRun> = {}): CheckRun {
  const gate: GateResult = {
    gate: 'architecture',
    status: violations.length > 0 ? 'red' : 'green',
    violations,
    baselinedCount: 0,
    durationMs: 1,
    cacheHits: 0,
    dependsOn: [],
  };
  return {
    verdict: violations.length > 0 ? 'red' : 'green',
    gates: [gate],
    advisories: [],
    scannedAt: 0,
    ungroundedComponents: [],
    blindSpots: [],
    observedFiles: { source: new Set(), manifest: new Set() },
    observedViolations: [],
    componentMatchCounts: new Map(),
    ...overrides,
  };
}

export function errorCheckRun(): CheckRun {
  const gate: GateResult = {
    gate: 'architecture',
    status: 'error',
    violations: [],
    baselinedCount: 0,
    errorMessage: 'eslint binary not found',
    durationMs: 1,
    cacheHits: 0,
    dependsOn: [],
  };
  return { verdict: 'error', gates: [gate], advisories: [], scannedAt: 0, ungroundedComponents: [], blindSpots: [], observedFiles: { source: new Set(), manifest: new Set() }, observedViolations: [], componentMatchCounts: new Map() };
}
