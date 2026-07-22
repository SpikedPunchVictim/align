/**
 * End-to-end falsification for ADR 017 Part A's browser-safety flagship use case
 * (`cannotDependOn(external('node:*'))`) against a REAL scan, not just synthetic evaluator
 * fixtures (`evaluators.test.ts` in `@spikedpunch/align-core` covers the synthetic-graph cases —
 * this proves the same DSL construct fires through the real TypeScript scanner too). Uses the
 * existing `external-imports` fixture (a real Node builtin + a real npm package import) for the
 * "red" case and the `clean` fixture (zero external imports) for the "green when the import is
 * absent" case — two fixtures, not one runtime-mutated file, since fixtures are checked in.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateRule, toComponentName, toRuleId } from '@spikedpunch/align-core';
import type { ArchLayersRule, ArchNoDependencyRule, ComponentDefinitionIR } from '@spikedpunch/align-core';
import { external } from '@spikedpunch/align-core/dsl';
import { TypeScriptScanner } from '../src/scanner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

function webComponent(): Record<string, ComponentDefinitionIR> {
  return { [toComponentName('web')]: { name: 'web', selector: { kind: 'glob', patterns: ['src/**'] }, empty: 'fail' } };
}

describe('external(...) selector rules against a real scan (ADR 017 Part A falsification)', () => {
  describe('cannotDependOn(external("node:*")) — the browser-safety flagship case', () => {
    // Copied into an isolated temp dir (own `node_modules/left-pad`, not the checked-in fixture's
    // — `scanner.test.ts`'s own external-package-retention suite writes/removes a `node_modules`
    // under the SAME checked-in `external-imports` fixture concurrently; sharing that path here
    // races when both test files run in parallel workers).
    let wsRoot: string;

    beforeAll(() => {
      wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'align-external-selector-test-'));
      fs.cpSync(path.join(fixturesDir, 'external-imports'), wsRoot, { recursive: true });
      const pkgDir = path.join(wsRoot, 'node_modules', 'left-pad');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }));
      fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = function leftPad() {};\n');
    });

    afterAll(() => {
      fs.rmSync(wsRoot, { recursive: true, force: true });
    });

    it('goes RED on a real node:child_process import (both node:-prefixed and bare specifier forms)', async () => {
      const scanner = new TypeScriptScanner();
      const graph = await scanner.scan({ rootDir: wsRoot, components: webComponent(), excludes: [] });

      const selector = external('node:*');
      const rule: ArchNoDependencyRule = {
        kind: 'arch.no-dependency',
        id: 'arch.no-dependency:web->external:node:*',
        from: 'web',
        to: { kind: 'external', pattern: selector.pattern, includeTypeOnly: selector.includeTypeOnly },
        provenance: {},
      };

      const violations = evaluateRule(rule, graph, {});
      expect(violations).toHaveLength(2); // a.ts (node:child_process) + b.ts (bare child_process)
      const files = violations.map((v) => v.file).sort();
      expect(files).toEqual(['src/a.ts', 'src/b.ts']);
      expect(violations.every((v) => v.kind === 'no-dependency-external')).toBe(true);
    });

    it('does not flag the non-builtin left-pad import — node:* only matches builtins', async () => {
      const scanner = new TypeScriptScanner();
      const graph = await scanner.scan({ rootDir: wsRoot, components: webComponent(), excludes: [] });

      const rule: ArchNoDependencyRule = {
        kind: 'arch.no-dependency',
        id: 'r1',
        from: 'web',
        to: { kind: 'external', pattern: 'node:*', includeTypeOnly: false },
        provenance: {},
      };
      const violations = evaluateRule(rule, graph, {});
      expect(violations.some((v) => v.kind === 'no-dependency-external' && v.externalPackageName === 'left-pad')).toBe(false);
    });

    it('canOnlyDependOn(external("node:*")) reproduces the same red via the default-deny allow-list arm (vscode browser-layer shape)', async () => {
      const scanner = new TypeScriptScanner();
      const graph = await scanner.scan({ rootDir: wsRoot, components: webComponent(), excludes: [] });

      // An allow-list naming NOTHING but node:* — every other external (left-pad) is forbidden by
      // the default-deny shape, and node builtins are explicitly allowed. This isolates the
      // allow-list arm's own default-deny behavior: swap the pattern to something that does NOT
      // match left-pad ('react') so left-pad is flagged, proving the arm actually enforces deny.
      const rule: ArchLayersRule = {
        kind: 'arch.layers',
        id: toRuleId('r2'),
        layers: [{ layer: toComponentName('web'), canDependOn: [{ kind: 'external', pattern: 'react', includeTypeOnly: false }] }],
        provenance: {},
      };
      const violations = evaluateRule(rule, graph, {});
      const leftPadFlagged = violations.some((v) => v.kind === 'layers-external' && v.externalPackageName === 'left-pad');
      expect(leftPadFlagged).toBe(true);
    });
  });

  it('goes GREEN when there is no matching import at all (clean fixture, zero external edges)', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: path.join(fixturesDir, 'clean'), components: webComponent(), excludes: [] });
    expect(graph.externalEdges).toHaveLength(0);

    const rule: ArchNoDependencyRule = {
      kind: 'arch.no-dependency',
      id: 'r1',
      from: 'web',
      to: { kind: 'external', pattern: 'node:*', includeTypeOnly: false },
      provenance: {},
    };
    expect(evaluateRule(rule, graph, {})).toHaveLength(0);
  });
});
