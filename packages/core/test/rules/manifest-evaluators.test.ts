import { describe, expect, it } from 'vitest';
import { evaluateManifestRule, evaluateNewDependency, evaluateSourceHygiene } from '../../src/rules/manifest-evaluators.js';
import { toRepoRelativePath, toRuleId } from '../../src/types/branded.js';
import type { SecurityManifestNewDependencyRule, SecurityManifestSourceHygieneRule } from '../../src/types/ir.js';
import type { ManifestInventory, ManifestRecord } from '../../src/types/manifest.js';

const sourceHygieneRule: SecurityManifestSourceHygieneRule = {
  kind: 'security.manifest.source-hygiene',
  id: 'security.manifest.source-hygiene',
  provenance: {},
};

const newDependencyRule: SecurityManifestNewDependencyRule = {
  kind: 'security.manifest.new-dependency',
  id: 'security.manifest.new-dependency',
  provenance: {},
};

function manifest(file: string, raw: string, deps: ManifestRecord['dependencies']): ManifestRecord {
  return { file: toRepoRelativePath(file), raw, dependencies: deps };
}

function inventory(...manifests: ManifestRecord[]): ManifestInventory {
  return { manifests, lockfilePresent: true };
}

describe('evaluateSourceHygiene (security.manifest.source-hygiene, ADR 013)', () => {
  it('flags an http(s) tarball specifier (probe-verified n8n case: xlsx CDN tarball)', () => {
    const raw = '{\n  "dependencies": {\n    "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz"\n  }\n}\n';
    const inv = inventory(
      manifest('packages/foo/package.json', raw, [
        { name: 'xlsx', specifier: 'https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz', field: 'dependencies', line: 3 },
      ]),
    );
    const violations = evaluateSourceHygiene(sourceHygieneRule, inv);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'manifest-source-hygiene',
      category: 'security',
      file: 'packages/foo/package.json',
      depName: 'xlsx',
      specifier: 'https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz',
      sourceType: 'http',
    });
    expect(violations[0]?.range).toEqual({ startLine: 3, endLine: 3 });
    expect(violations[0]?.fixHint).toEqual({ code: 'manual-review' });
  });

  it('flags a git-pinned specifier (probe-verified n8n case: wa-sqlite commit pin)', () => {
    const raw = '{\n  "dependencies": {\n    "wa-sqlite": "github:rhashimoto/wa-sqlite#779219540f66cecaa159da32b3b8936697ba10a7"\n  }\n}\n';
    const inv = inventory(
      manifest('packages/bar/package.json', raw, [
        { name: 'wa-sqlite', specifier: 'github:rhashimoto/wa-sqlite#779219540f66cecaa159da32b3b8936697ba10a7', field: 'dependencies', line: 3 },
      ]),
    );
    const violations = evaluateSourceHygiene(sourceHygieneRule, inv);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ depName: 'wa-sqlite', sourceType: 'git' });
  });

  it('flags file: and link: specifiers', () => {
    const inv = inventory(
      manifest('package.json', '{}', [
        { name: 'local-a', specifier: 'file:../local-a', field: 'dependencies' },
        { name: 'local-b', specifier: 'link:../local-b', field: 'devDependencies' },
      ]),
    );
    const violations = evaluateSourceHygiene(sourceHygieneRule, inv);
    expect(violations.map((v) => (v.kind === 'manifest-source-hygiene' ? v.sourceType : undefined)).sort()).toEqual(['file', 'link']);
  });

  it('does NOT flag a registry specifier, a workspace: protocol dep, or an npm: alias', () => {
    const inv = inventory(
      manifest('package.json', '{}', [
        { name: 'zod', specifier: '^3.23.8', field: 'dependencies' },
        { name: '@align/core', specifier: 'workspace:*', field: 'dependencies' },
        { name: 'aliased', specifier: 'npm:real-package@^1.0.0', field: 'dependencies' },
        { name: 'cataloged', specifier: 'catalog:', field: 'dependencies' },
      ]),
    );
    expect(evaluateSourceHygiene(sourceHygieneRule, inv)).toHaveLength(0);
  });

  it('fingerprint is stable across a specifier change (name-level, ADR 013) but distinct per dep name', () => {
    const before = evaluateSourceHygiene(sourceHygieneRule, inventory(manifest('package.json', '{}', [
      { name: 'xlsx', specifier: 'https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz', field: 'dependencies' },
    ])));
    // A revision bump — same name, different URL/ref.
    const after = evaluateSourceHygiene(sourceHygieneRule, inventory(manifest('package.json', '{}', [
      { name: 'xlsx', specifier: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz', field: 'dependencies' },
    ])));
    expect(before[0]?.id).toBe(after[0]?.id);

    const other = evaluateSourceHygiene(sourceHygieneRule, inventory(manifest('package.json', '{}', [
      { name: 'wa-sqlite', specifier: 'github:rhashimoto/wa-sqlite#abc', field: 'dependencies' },
    ])));
    expect(before[0]?.id).not.toBe(other[0]?.id);
  });

  it('golden case: falls back to a synthesized snippet when no raw-text line was located', () => {
    const inv = inventory(manifest('package.json', '{}', [{ name: 'xlsx', specifier: 'https://example.com/xlsx.tgz', field: 'dependencies' }]));
    const violations = evaluateSourceHygiene(sourceHygieneRule, inv);
    expect(violations[0]?.range).toEqual({ startLine: 1, endLine: 1 });
    expect(violations[0]?.snippet).toBe('"xlsx": "https://example.com/xlsx.tgz"');
  });
});

describe('evaluateNewDependency (security.manifest.new-dependency, ADR 013)', () => {
  it('flags every current runtime and dev dependency (name-level, baseline consent does the rest)', () => {
    const inv = inventory(
      manifest('package.json', '{}', [
        { name: 'zod', specifier: '^3.23.8', field: 'dependencies' },
        { name: 'vitest', specifier: '^2.1.4', field: 'devDependencies' },
      ]),
    );
    const violations = evaluateNewDependency(newDependencyRule, inv);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => (v.kind === 'manifest-new-dependency' ? v.depField : undefined)).sort()).toEqual(['dependencies', 'devDependencies']);
  });

  it('excludes optionalDependencies (runtime+dev only, ADR 013)', () => {
    const inv = inventory(manifest('package.json', '{}', [{ name: 'fsevents', specifier: '^2.3.0', field: 'optionalDependencies' }]));
    expect(evaluateNewDependency(newDependencyRule, inv)).toHaveLength(0);
  });

  it('fingerprint is keyed on (manifest file, dep name) — stable across a version bump (name-level doctrine)', () => {
    const before = evaluateNewDependency(newDependencyRule, inventory(manifest('package.json', '{}', [{ name: 'zod', specifier: '^3.23.8', field: 'dependencies' }])));
    const afterBump = evaluateNewDependency(newDependencyRule, inventory(manifest('package.json', '{}', [{ name: 'zod', specifier: '^3.24.0', field: 'dependencies' }])));
    expect(before[0]?.id).toBe(afterBump[0]?.id);
  });

  it('a genuinely new dependency name gets a distinct fingerprint from every existing one', () => {
    const existing = evaluateNewDependency(newDependencyRule, inventory(manifest('package.json', '{}', [{ name: 'zod', specifier: '^3.23.8', field: 'dependencies' }])));
    const withNew = evaluateNewDependency(
      newDependencyRule,
      inventory(manifest('package.json', '{}', [
        { name: 'zod', specifier: '^3.23.8', field: 'dependencies' },
        { name: '@anthropic-ai/sdk', specifier: '^0.30.0', field: 'dependencies' },
      ])),
    );
    const existingIds = new Set(existing.map((v) => v.id));
    const newIds = withNew.filter((v) => !existingIds.has(v.id));
    expect(newIds).toHaveLength(1);
    expect(newIds[0]).toMatchObject({ kind: 'manifest-new-dependency', depName: '@anthropic-ai/sdk' });
  });
});

describe('evaluateManifestRule (exhaustive dispatcher, ADR 008 discipline)', () => {
  it('dispatches source-hygiene rules to evaluateSourceHygiene', () => {
    const inv = inventory(manifest('package.json', '{}', [{ name: 'xlsx', specifier: 'https://example.com/xlsx.tgz', field: 'dependencies' }]));
    expect(evaluateManifestRule(sourceHygieneRule, inv)).toHaveLength(1);
  });

  it('dispatches new-dependency rules to evaluateNewDependency', () => {
    const inv = inventory(manifest('package.json', '{}', [{ name: 'zod', specifier: '^3.23.8', field: 'dependencies' }]));
    expect(evaluateManifestRule(newDependencyRule, inv)).toHaveLength(1);
  });

  it('violations carry a real RuleId matching the rule (baseline `--rule` scoping, ADR 006)', () => {
    const inv = inventory(manifest('package.json', '{}', [{ name: 'xlsx', specifier: 'https://example.com/xlsx.tgz', field: 'dependencies' }]));
    const violations = evaluateManifestRule(sourceHygieneRule, inv);
    expect(violations[0]?.ruleId).toBe(toRuleId('security.manifest.source-hygiene'));
  });
});
