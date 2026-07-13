import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { toComponentName } from '@spikedpunch/align-core';
import type { ComponentDefinitionIR } from '@spikedpunch/align-core';
import { extractExportedSymbols } from '../src/exports.js';
import { TypeScriptScanner } from '../src/scanner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

function sourceFileFor(text: string): ts.SourceFile {
  return ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
}

function allComponent(): Record<string, ComponentDefinitionIR> {
  return { [toComponentName('all')]: { name: 'all', selector: { kind: 'glob', patterns: ['**'] }, allowEmpty: false } };
}

describe('extractExportedSymbols', () => {
  it('extracts named function, const, class, interface, type, and enum declaration exports', () => {
    const source = sourceFileFor(`
      export function foo(): void {}
      export const bar = 1;
      export let baz = 2;
      export class Widget {}
      export interface Shape {}
      export type Alias = string;
      export enum Color { Red, Blue }
    `);
    expect(extractExportedSymbols(source).sort()).toEqual(
      ['Alias', 'Color', 'Shape', 'Widget', 'bar', 'baz', 'foo'].sort(),
    );
  });

  it('extracts destructured export const bindings', () => {
    const source = sourceFileFor(`export const { a, b: c } = obj;`);
    expect(extractExportedSymbols(source).sort()).toEqual(['a', 'c']);
  });

  it('represents export default as the literal "default", not the local name', () => {
    const source = sourceFileFor(`export default function main(): void {}`);
    expect(extractExportedSymbols(source)).toEqual(['default']);
  });

  it('represents a bare expression export default as "default"', () => {
    const source = sourceFileFor(`const x = 1;\nexport default x;`);
    expect(extractExportedSymbols(source)).toEqual(['default']);
  });

  it('resolves named export lists to the importer-facing (aliased) name', () => {
    const source = sourceFileFor(`const foo = 1, bar = 2;\nexport { foo, bar as baz };`);
    expect(extractExportedSymbols(source).sort()).toEqual(['baz', 'foo']);
  });

  it('resolves re-exported named lists without needing to resolve the target module', () => {
    const source = sourceFileFor(`export { foo, bar as baz } from './other.js';`);
    expect(extractExportedSymbols(source).sort()).toEqual(['baz', 'foo']);
  });

  it('does not crash on export * from and adds no symbols for it', () => {
    const source = sourceFileFor(`export * from './other.js';`);
    expect(extractExportedSymbols(source)).toEqual([]);
  });

  it('extracts the namespace binding name from export * as ns from', () => {
    const source = sourceFileFor(`export * as ns from './other.js';`);
    expect(extractExportedSymbols(source)).toEqual(['ns']);
  });

  it('returns an empty array for a file with no exports', () => {
    const source = sourceFileFor(`const internalOnly = 1;\nfunction helper(): number { return internalOnly; }`);
    expect(extractExportedSymbols(source)).toEqual([]);
  });
});

describe('TypeScriptScanner — exports fixture', () => {
  it('populates DependencyGraphNode.exports for named, default, and re-export files, skipping barrel targets', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: path.join(fixturesDir, 'exports'), components: allComponent(), excludes: [] });

    const named = graph.nodes.find((n) => n.file === 'src/named.ts');
    expect(named?.exports.slice().sort()).toEqual(['Baz', 'bar', 'foo']);

    const defaultExport = graph.nodes.find((n) => n.file === 'src/default.ts');
    expect(defaultExport?.exports).toEqual(['default']);

    const reexport = graph.nodes.find((n) => n.file === 'src/reexport.ts');
    // `export { foo, bar as baz } from './named.js'` contributes baz/foo; `export * from
    // './default.js'` is a barrel and deliberately contributes nothing (no cross-file resolution).
    expect(reexport?.exports.slice().sort()).toEqual(['baz', 'foo']);

    const empty = graph.nodes.find((n) => n.file === 'src/empty.ts');
    expect(empty?.exports).toEqual([]);
  });
});
