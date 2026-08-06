import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAgentInstructions } from '../../src/init/claude-md.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'align-claude-md-test-'));
}

const START = '<!-- align:start -->';
const END = '<!-- align:end -->';

describe('writeAgentInstructions', () => {
  it('state 1: file absent -> creates a well-formed block, idempotently', () => {
    tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'CLAUDE.md');

    writeAgentInstructions(tmpDir);
    const first = fs.readFileSync(filePath, 'utf8');
    expect(first).toContain(START);
    expect(first).toContain(END);

    writeAgentInstructions(tmpDir);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(first);
  });

  it('state 2: human content, no markers -> appends, human content preserved, idempotently', () => {
    tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    const human = '# My Project\n\nSome hand-written project instructions.\n';
    fs.writeFileSync(filePath, human, 'utf8');

    writeAgentInstructions(tmpDir);
    const first = fs.readFileSync(filePath, 'utf8');
    expect(first).toContain(human.trim());
    expect(first).toContain(START);

    writeAgentInstructions(tmpDir);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(first);
  });

  it('state 3: exactly one well-formed pair -> splices in place, human content preserved, idempotently', () => {
    tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, `# Before\n\n${START}\nstale content\n${END}\n\n# After\n`, 'utf8');

    writeAgentInstructions(tmpDir);
    const first = fs.readFileSync(filePath, 'utf8');
    expect(first).toContain('# Before');
    expect(first).toContain('# After');
    expect(first).not.toContain('stale content');
    expect(first.split(START)).toHaveLength(2);
    expect(first.split(END)).toHaveLength(2);

    writeAgentInstructions(tmpDir);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(first);
  });

  it('state 4: START marker only, no END -> throws instead of silently deleting human content on the next run', () => {
    tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    const original = `# Human notes\n\n${START}\nstale (interrupted write, no closing marker)\n`;
    fs.writeFileSync(filePath, original, 'utf8');

    expect(() => writeAgentInstructions(tmpDir)).toThrow(/malformed align block/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('state 5: END marker only, no START -> throws', () => {
    tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    const original = `# Human notes\n\nstale\n${END}\n`;
    fs.writeFileSync(filePath, original, 'utf8');

    expect(() => writeAgentInstructions(tmpDir)).toThrow(/malformed align block/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('state 6: END marker before START -> throws instead of appending an unbounded extra block', () => {
    tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    const original = `${END}\nsome text\n${START}\n`;
    fs.writeFileSync(filePath, original, 'utf8');

    expect(() => writeAgentInstructions(tmpDir)).toThrow(/malformed align block/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('state 7: two complete marker pairs -> throws instead of refreshing only the first and leaving the second stale', () => {
    tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    const original = `${START}\nold1\n${END}\n\nmiddle\n\n${START}\nold2\n${END}\n`;
    fs.writeFileSync(filePath, original, 'utf8');

    expect(() => writeAgentInstructions(tmpDir)).toThrow(/malformed align block/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });
});
