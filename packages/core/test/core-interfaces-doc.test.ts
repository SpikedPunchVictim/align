import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `docs/core-interfaces.md`'s `McpCheckPayload` block must list exactly the fields the interface
 * declares.
 *
 * **This is the mechanism that actually failed.** ADR 028 renamed `skippedNestedCheckouts` to
 * `blindSpots` on the payload, and reviewing the doc turned up something worse than the rename: the
 * documented block had stopped at `advisories` and was **four fields behind** — `ungroundedComponents`
 * (added for greenfield mode), `blindSpots`, `baselineDebt` and `complete` were all live on the wire
 * and absent from the document an MCP consumer reads. Nothing noticed, because nothing was looking.
 *
 * A payload version field would not have caught this and is a different problem (ADR 028's
 * Consequences records that `CheckPayload` carries none, so every rename after 0.2.0 is an
 * unsignallable break). Versioning tells a consumer that the shape changed; it does not tell US that
 * the documentation stopped describing it. Only comparing the two does.
 *
 * **Why the compiler API rather than comparing runtime keys.** A runtime comparison can only see
 * fields present on an actual payload object, so it is blind in exactly the place documentation
 * drifts first: an absent optional. `pagination?` appears on no green run's payload, and neither
 * does any future optional field — a key-set comparison would call the doc correct while it silently
 * omitted them. Parsing both declarations sees what is DECLARED, optionals included, which is what
 * the document claims to describe. `typescript` is already a devDependency here (and a first-class
 * dependency of `plugin-typescript`), so this costs no new tooling.
 *
 * Scope, stated so nobody reads more into a green than it means: this compares the field NAME SET
 * and each field's optionality. It deliberately does not compare types — the document abbreviates
 * them on purpose (`readonly gates: readonly {...}[]` is spelled out in one and summarised in the
 * other), and a comparison strict enough to reject that would be abandoned within a release. Field
 * order and comments are free.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOC = path.join(REPO_ROOT, 'docs', 'core-interfaces.md');
const SOURCE = path.join(REPO_ROOT, 'packages', 'core', 'src', 'payload', 'builder.ts');
const INTERFACE_NAME = 'McpCheckPayload';

/**
 * The interfaces this document is CHECKED against, and the source each is declared in.
 *
 * Started as `McpCheckPayload` alone, which made the describe below ("stays in step with the
 * interfaces it documents") an overclaim — the document declares 39 interfaces and one was
 * enforced. Adversarial review then found four more that had drifted, including
 * `DependencyGraph.blindSpots`, which `ARCHITECTURE.md` cites by name: a reader following that
 * citation into this document found no such field.
 *
 * Adding a row here is the cheap half. The expensive half is that an unenforced block is worse than
 * an absent one, because it reads as current — so prefer enforcing a block to documenting it.
 */
const ENFORCED: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'McpCheckPayload', source: 'packages/core/src/payload/builder.ts' },
  { name: 'CheckRun', source: 'packages/core/src/gates/types.ts' },
  { name: 'DependencyGraph', source: 'packages/core/src/types/graph.ts' },
  { name: 'ManifestInventory', source: 'packages/core/src/types/manifest.ts' },
  { name: 'ScanInput', source: 'packages/core/src/scanner.ts' },
  { name: 'BaselineEntry', source: 'packages/core/src/baseline/store.ts' },
];

interface Field {
  readonly name: string;
  readonly optional: boolean;
}

/** Every fenced ```ts block in the markdown, concatenated in document order. The interface could
 * legitimately move between blocks (it has already moved sections once), so this does not depend on
 * WHICH block holds it — only that exactly one declaration of it exists somewhere in the file. */
function typeScriptBlocks(markdown: string): string {
  const blocks: string[] = [];
  const fence = /^```ts\s*$/;
  let inside = false;
  let current: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!inside && fence.test(line)) {
      inside = true;
      current = [];
      continue;
    }
    if (inside && line.trim() === '```') {
      inside = false;
      blocks.push(current.join('\n'));
      continue;
    }
    if (inside) current.push(line);
  }
  return blocks.join('\n');
}

/** The declared members of `name`, via the compiler's own parser rather than a regex — a regex over
 * a nested object-literal member (`gates`) is the kind of thing that appears to work until the day
 * it does not. Throws rather than returning empty when the interface is missing: an empty field set
 * would compare equal to another empty field set and turn this whole test permanently green, which
 * is the failure shape this repo treats as severity-zero. */
function declaredFields(code: string, name: string, origin: string): readonly Field[] {
  const source = ts.createSourceFile(`${name}.ts`, code, ts.ScriptTarget.Latest, true);
  const found = source.statements.filter(
    (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one \`interface ${name}\` in ${origin}, found ${found.length} — ` +
        'this check cannot compare what it cannot locate, and returning an empty field set here would make it pass forever.',
    );
  }
  const [declaration] = found;
  return declaration!.members.filter(ts.isPropertySignature).map((member) => ({
    name: member.name.getText(source),
    optional: member.questionToken !== undefined,
  }));
}

function format(fields: readonly Field[]): readonly string[] {
  return [...fields].map((f) => `${f.name}${f.optional ? '?' : ''}`).sort();
}

describe('docs/core-interfaces.md stays in step with the interfaces it documents', () => {
  it.each(ENFORCED)('documents exactly the fields `$name` declares', ({ name, source }) => {
    const documented = declaredFields(typeScriptBlocks(fs.readFileSync(DOC, 'utf8')), name, 'docs/core-interfaces.md');
    const declared = declaredFields(fs.readFileSync(path.join(REPO_ROOT, source), 'utf8'), name, source);
    expect(format(documented)).toEqual(format(declared));
  });

  it(`documents exactly the fields \`${INTERFACE_NAME}\` declares`, () => {
    const documented = declaredFields(typeScriptBlocks(fs.readFileSync(DOC, 'utf8')), INTERFACE_NAME, 'docs/core-interfaces.md');
    const declared = declaredFields(fs.readFileSync(SOURCE, 'utf8'), INTERFACE_NAME, 'packages/core/src/payload/builder.ts');

    // Compared as sorted `name?` strings so a failure names the drifting fields directly, instead of
    // printing two object arrays a reader has to diff by eye.
    expect(format(documented)).toEqual(format(declared));
  });

  // Calibration. The check above compares two lists; if either extractor silently returned nothing,
  // it would pass forever. This proves both halves see real fields, and that the comparison
  // distinguishes a missing field from a present one — the exact drift that went unnoticed.
  it('is calibrated: both extractors find fields, and a missing field fails the comparison', () => {
    const declared = declaredFields(fs.readFileSync(SOURCE, 'utf8'), INTERFACE_NAME, SOURCE);
    expect(declared.length).toBeGreaterThan(5);
    expect(format(declared)).toContain('pagination?');
    expect(format(declared)).toContain('blindSpots');

    const truncated = declared.filter((f) => f.name !== 'blindSpots');
    expect(format(truncated)).not.toEqual(format(declared));
  });

  it('rejects a documentation block that declares the interface twice or not at all', () => {
    expect(() => declaredFields('', INTERFACE_NAME, 'empty fixture')).toThrow(/found 0/);
    expect(() => declaredFields(`interface ${INTERFACE_NAME} {}\ninterface ${INTERFACE_NAME} {}`, INTERFACE_NAME, 'double fixture')).toThrow(
      /found 2/,
    );
  });
});
