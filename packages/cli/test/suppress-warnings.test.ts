import { describe, expect, it } from 'vitest';
import { isSuppressedWarning } from '../src/suppress-warnings.js';

describe('isSuppressedWarning', () => {
  it('suppresses the MODULE_TYPELESS_PACKAGE_JSON note (benign config-load perf warning)', () => {
    expect(isSuppressedWarning({ code: 'MODULE_TYPELESS_PACKAGE_JSON' })).toBe(true);
  });

  it('does not suppress unrelated warnings (deprecations, experimental features, etc.)', () => {
    expect(isSuppressedWarning({ code: 'DEP0040' })).toBe(false);
    expect(isSuppressedWarning({ code: 'ExperimentalWarning' })).toBe(false);
    expect(isSuppressedWarning({})).toBe(false);
  });
});
