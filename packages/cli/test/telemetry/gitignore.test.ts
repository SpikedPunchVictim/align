import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTelemetryGitignored } from '../../src/init/gitignore.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureTelemetryGitignored', () => {
  it('creates .gitignore with both telemetry entries when none exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-gitignore-'));
    const wrote = ensureTelemetryGitignored(tmpDir);
    expect(wrote).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(content).toContain('.align/telemetry.jsonl');
    expect(content).toContain('.align/telemetry-state.json');
  });

  it('appends entries to an existing .gitignore without disturbing its content', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-gitignore-'));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    const wrote = ensureTelemetryGitignored(tmpDir);
    expect(wrote).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('dist/');
    expect(content).toContain('.align/telemetry.jsonl');
    expect(content).toContain('.align/telemetry-state.json');
  });

  it('is idempotent — a second call is a no-op and never duplicates entries', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-gitignore-'));
    ensureTelemetryGitignored(tmpDir);
    const secondCallWrote = ensureTelemetryGitignored(tmpDir);
    expect(secondCallWrote).toBe(false);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(content.split('.align/telemetry.jsonl').length - 1).toBe(1);
    expect(content.split('.align/telemetry-state.json').length - 1).toBe(1);
  });

  it('does nothing when both entries are already present (e.g. hand-authored)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-gitignore-'));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.align/telemetry.jsonl\n.align/telemetry-state.json\n', 'utf8');
    expect(ensureTelemetryGitignored(tmpDir)).toBe(false);
  });

  it('never blanket-ignores .align/ itself', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-gitignore-'));
    ensureTelemetryGitignored(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const lines = content.split('\n').map((l) => l.trim());
    expect(lines).not.toContain('.align/');
    expect(lines).not.toContain('.align');
  });
});
