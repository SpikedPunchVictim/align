/**
 * Condensed symbol table extraction (Stage 4: FixProposal grounding): a pure, best-effort static
 * syntactic pass over an already-parsed `ts.SourceFile` that lists a module's importable symbol
 * names — the "default" sentinel for `export default`, and declared/re-exported names otherwise.
 * Deliberately mirrors `scanFile`'s parse -> extract -> discard philosophy: no type-checking
 * `ts.Program`, no cross-file resolution. `export * from './other'` barrels are the one case that
 * would require resolving and scanning the target module to enumerate; that's out of scope here,
 * so barrels are recognized (not crashed on) and simply contribute no symbols of their own.
 */
import ts from 'typescript';

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

/** Flattens a (possibly destructured) binding name into the identifiers it introduces, e.g.
 * `export const { a, b: c } = obj;` yields `['a', 'c']`. */
function collectBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...collectBindingNames(element.name));
  }
  return names;
}

/** Extracts the set of names importable from this module. Only walks top-level statements —
 * import/export declarations are only valid there in a module, so no need for a full recursive
 * AST walk (unlike edge extraction, which must find nested dynamic `import()`/`require()` calls). */
export function extractExportedSymbols(sourceFile: ts.SourceFile): string[] {
  const symbols = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      // `export default expr;` (isExportEquals: false) contributes the default sentinel.
      // `export = expr;` (isExportEquals: true) is CommonJS-only export-assignment syntax with no
      // ESM-style named/default symbol to ground fixes against — skipped.
      if (!statement.isExportEquals) symbols.add('default');
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined) {
        // `export * from './other'` — a barrel re-export. Enumerating its contents would require
        // resolving and scanning the target module (cross-file), which this per-file pass
        // deliberately doesn't do (see module doc comment). Not a crash, just no symbols added.
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        // Covers both `export { foo, bar as baz }` and `export { foo } from './other'` — either
        // way, `.name` is the externally-visible (importer-facing) identifier.
        for (const specifier of statement.exportClause.elements) symbols.add(specifier.name.text);
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        // `export * as ns from './other'` — unlike a bare `export *`, the namespace binding name
        // itself is statically known without resolving the target.
        symbols.add(statement.exportClause.name.text);
      }
      continue;
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;

    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      // `export default function foo() {}` / `export default class Foo {}` — importable only as
      // "default"; the local name `foo`/`Foo` isn't a separate importable symbol.
      symbols.add('default');
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) symbols.add(statement.name.text);
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      symbols.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of collectBindingNames(declaration.name)) symbols.add(name);
      }
    }
  }

  return [...symbols];
}
