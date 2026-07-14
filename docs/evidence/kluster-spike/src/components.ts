/**
 * Hardcoded components map for kluster, derived from its real layout
 * (pnpm-workspace.yaml + package.json names, inspected read-only).
 *
 * Notable reality checks encoded here:
 * - `fold-workbench` covers packages/workbench/fold + foldv2. The @fold/* packages are
 *   NOT in any pnpm-workspace glob (orphaned packages) — the component map absorbs them anyway.
 * - `sdd-tooling` covers packages/workbench/sdd minus its apps/ subtree (excluded from the
 *   scan entirely per user directive: pipeline test-run output, not source).
 */

export interface Component {
  readonly name: string;
  readonly pathPrefixes: readonly string[];
  readonly packageNames: readonly string[];
  readonly description: string;
}

export const COMPONENTS: readonly Component[] = [
  {
    name: 'api-app',
    pathPrefixes: ['application/api/'],
    packageNames: ['@kluster/api'],
    description: 'Backend application (fastify; layered routes/services/domain/infrastructure).',
  },
  {
    name: 'ui-app',
    pathPrefixes: ['application/ui/'],
    packageNames: ['@kluster/ui'],
    description: 'React frontend application.',
  },
  {
    name: 'bt-core',
    pathPrefixes: ['packages/kluster-bt/core/'],
    packageNames: ['@kluster/core'],
    description: 'Behavior-tree engine core. Must stay independent of node plugins and CLI.',
  },
  {
    name: 'bt-nodes',
    pathPrefixes: [
      'packages/kluster-bt/cli/',
      'packages/kluster-bt/workflows/',
      'packages/kluster-bt/nodes-fs/',
      'packages/kluster-bt/nodes-git/',
      'packages/kluster-bt/nodes-http/',
      'packages/kluster-bt/nodes-llm/',
    ],
    packageNames: [
      '@kluster/cli',
      '@kluster/workflows',
      '@kluster/nodes-fs',
      '@kluster/nodes-git',
      '@kluster/nodes-http',
      '@kluster/nodes-llm',
    ],
    description: 'Behavior-tree node plugins, workflows, and the CLI built on bt-core.',
  },
  {
    name: 'llm-providers',
    pathPrefixes: [
      'packages/kluster-bt/llm-types/',
      'packages/kluster-bt/llm-anthropic/',
      'packages/kluster-bt/llm-openai/',
      'packages/kluster-bt/llm-ollama/',
    ],
    packageNames: ['@kluster/llm-types', '@kluster/llm-anthropic', '@kluster/llm-openai', '@kluster/llm-ollama'],
    description: 'LLM provider adapters and their shared type contracts.',
  },
  {
    name: 'mast',
    pathPrefixes: ['packages/mast/'],
    packageNames: ['@kluster/mast'],
    description: 'Standalone code-indexing tool.',
  },
  {
    name: 'fold-workbench',
    pathPrefixes: ['packages/workbench/fold/', 'packages/workbench/foldv2/'],
    packageNames: [], // @fold/* and @foldv2/* — @fold/* is not even in the pnpm workspace
    description: 'Build-pipeline workbench tooling (fold + foldv2). @fold/* packages are workspace-orphaned.',
  },
  {
    name: 'sdd-tooling',
    pathPrefixes: ['packages/workbench/sdd/'],
    packageNames: [],
    description: 'SDD pipeline tooling (runners, flows, monitoring). Its apps/ subtree is excluded from scans.',
  },
];

/** First-prefix-match-wins classification. Undefined = unmapped (reported, feeds Q5). */
export function classifyFile(repoRelativePath: string): string | undefined {
  for (const component of COMPONENTS) {
    for (const prefix of component.pathPrefixes) {
      if (repoRelativePath.startsWith(prefix)) return component.name;
    }
  }
  return undefined;
}

export function componentByName(name: string): Component | undefined {
  return COMPONENTS.find((c) => c.name === name);
}
