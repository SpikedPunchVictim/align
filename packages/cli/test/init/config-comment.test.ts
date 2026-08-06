import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeGeneratedRulesNote } from '../../src/init/config-comment.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'align-config-comment-test-'));
}

const START = '// align:generated-rules-note:start';
const END = '// align:generated-rules-note:end';

// A representative hand-authored align.config.ts: a `defineProject` call with real rules — the
// content this bug (BUG #10) can destroy when the note block's markers are malformed.
const CONFIG_PRELUDE = `import { defineProject } from '@spikedpunch/align-core/dsl';

export default defineProject({
  components: { api: 'src/api/**', ui: 'src/ui/**' },
  rules: [
    { kind: 'arch.no-cycles', components: ['api', 'ui'] },
    { kind: 'arch.no-dependency', from: 'ui', to: 'api' },
  ],
});
`;

function expectRulesetIntact(content: string): void {
  expect(content).toContain('defineProject');
  expect(content).toContain("kind: 'arch.no-cycles'");
  expect(content).toContain("kind: 'arch.no-dependency'");
}

describe('writeGeneratedRulesNote', () => {
  it('state 1: file absent -> no-ops (runInit writes align.config.ts first; nothing to annotate yet)', () => {
    tmpDir = makeTmpDir();
    const configPath = path.join(tmpDir, 'align.config.ts');
    expect(() => writeGeneratedRulesNote(configPath)).not.toThrow();
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('state 2: config content, no markers -> appends the note, ruleset preserved, idempotently', () => {
    tmpDir = makeTmpDir();
    const configPath = path.join(tmpDir, 'align.config.ts');
    fs.writeFileSync(configPath, CONFIG_PRELUDE, 'utf8');

    writeGeneratedRulesNote(configPath);
    const first = fs.readFileSync(configPath, 'utf8');
    expectRulesetIntact(first);
    expect(first).toContain(START);

    writeGeneratedRulesNote(configPath);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(first);
  });

  it('state 3: exactly one well-formed pair -> splices in place, ruleset preserved, idempotently', () => {
    tmpDir = makeTmpDir();
    const configPath = path.join(tmpDir, 'align.config.ts');
    fs.writeFileSync(configPath, `${CONFIG_PRELUDE}\n${START}\nstale note\n${END}\n`, 'utf8');

    writeGeneratedRulesNote(configPath);
    const first = fs.readFileSync(configPath, 'utf8');
    expectRulesetIntact(first);
    expect(first).not.toContain('stale note');

    writeGeneratedRulesNote(configPath);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(first);
  });

  it('state 4: START marker only, no END -> throws instead of destroying the hand-authored ruleset', () => {
    tmpDir = makeTmpDir();
    const configPath = path.join(tmpDir, 'align.config.ts');
    const original = `${CONFIG_PRELUDE}\n${START}\nstale note (interrupted write, no closing marker)\n`;
    fs.writeFileSync(configPath, original, 'utf8');

    expect(() => writeGeneratedRulesNote(configPath)).toThrow(/malformed align block/);
    // This is the destructive case (BUG #10): before the fix, a second run would splice from the
    // first START to the only END, deleting `defineProject`, `components`, and every rule.
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toBe(original);
    expectRulesetIntact(content);
  });

  it('state 5: END marker only, no START -> throws', () => {
    tmpDir = makeTmpDir();
    const configPath = path.join(tmpDir, 'align.config.ts');
    const original = `${CONFIG_PRELUDE}\nstale note\n${END}\n`;
    fs.writeFileSync(configPath, original, 'utf8');

    expect(() => writeGeneratedRulesNote(configPath)).toThrow(/malformed align block/);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toBe(original);
    expectRulesetIntact(content);
  });

  it('state 6: END marker before START -> throws instead of appending an unbounded extra note on every run', () => {
    tmpDir = makeTmpDir();
    const configPath = path.join(tmpDir, 'align.config.ts');
    const original = `${END}\n${CONFIG_PRELUDE}\n${START}\n`;
    fs.writeFileSync(configPath, original, 'utf8');

    expect(() => writeGeneratedRulesNote(configPath)).toThrow(/malformed align block/);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toBe(original);
    expectRulesetIntact(content);
  });

  it('state 7: two complete marker pairs -> throws instead of refreshing only the first', () => {
    tmpDir = makeTmpDir();
    const configPath = path.join(tmpDir, 'align.config.ts');
    const original = `${CONFIG_PRELUDE}\n${START}\nold1\n${END}\n\n${START}\nold2\n${END}\n`;
    fs.writeFileSync(configPath, original, 'utf8');

    expect(() => writeGeneratedRulesNote(configPath)).toThrow(/malformed align block/);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toBe(original);
    expectRulesetIntact(content);
  });
});
