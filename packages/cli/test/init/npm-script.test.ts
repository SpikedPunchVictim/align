import { describe, expect, it } from 'vitest';
import { addAlignScript } from '../../src/init/npm-script.js';

describe('addAlignScript', () => {
  it('adds "align": "align check" when no scripts object exists at all', () => {
    const result = addAlignScript({ name: 'my-app', version: '1.0.0' });
    expect(result.changed).toBe(true);
    expect(result.packageJson).toEqual({ name: 'my-app', version: '1.0.0', scripts: { align: 'align check' } });
  });

  it('adds "align": "align check" alongside existing scripts, preserving them', () => {
    const result = addAlignScript({ name: 'my-app', scripts: { build: 'tsc', test: 'vitest run' } });
    expect(result.changed).toBe(true);
    expect(result.packageJson).toEqual({
      name: 'my-app',
      scripts: { build: 'tsc', test: 'vitest run', align: 'align check' },
    });
  });

  it('no-ops when an "align" script already exists, whatever it runs — never overwritten', () => {
    const original = { name: 'my-app', scripts: { align: 'echo custom' } };
    const result = addAlignScript(original);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('already-present');
    expect(result.packageJson).toBe(original); // untouched, same reference
  });

  it('preserves every other top-level field (formatting concern: only scripts is touched)', () => {
    const original = { name: 'my-app', version: '2.3.4', private: true, dependencies: { zod: '^3.0.0' } };
    const result = addAlignScript(original);
    expect(result.changed).toBe(true);
    expect(result.packageJson).toMatchObject({ name: 'my-app', version: '2.3.4', private: true, dependencies: { zod: '^3.0.0' } });
  });
});
