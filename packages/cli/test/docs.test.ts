import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/program.js';
import { runDocs } from '../src/commands/docs.js';
import { DOCS_TOPICS, findDocsTopic, renderDocsIndex } from '../src/docs/topics.js';

const program = buildProgram();

describe('align docs topics', () => {
  it('every registered topic renders non-empty markdown', () => {
    for (const topic of DOCS_TOPICS) {
      expect(topic.render(program).length, `topic '${topic.id}' should render content`).toBeGreaterThan(20);
    }
  });

  it('the index lists every topic id and points at `align skill`', () => {
    const index = renderDocsIndex('0.0.0-test');
    for (const topic of DOCS_TOPICS) expect(index).toContain(topic.id);
    expect(index).toMatch(/align skill/);
    expect(index).toContain('0.0.0-test');
  });

  it('ships the align.config.ts API as the `config` topic (defineProject + the named exports)', () => {
    const config = findDocsTopic('config');
    expect(config).toBeDefined();
    const rendered = config?.render(program) ?? '';
    expect(rendered).toMatch(/defineProject/);
    expect(rendered).toMatch(/excludes/);
    expect(rendered).toMatch(/hostRules/);
  });

  it('returns undefined for an unknown topic', () => {
    expect(findDocsTopic('nope')).toBeUndefined();
  });
});

describe('runDocs', () => {
  it('prints the index and returns 0 with no topic', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runDocs(program, {})).toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('prints the requested topic and returns 0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runDocs(program, { topic: 'config' })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/defineProject/);
    log.mockRestore();
  });

  it('errors with the known-topic list and returns 1 on an unknown topic', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runDocs(program, { topic: 'nope' })).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/Unknown docs topic/);
    err.mockRestore();
  });
});
