import { describe, expect, it } from 'vitest';
import { AnthropicFixProvider } from '../src/anthropicFixProvider.js';

describe('AnthropicFixProvider.getUsageTotals', () => {
  it('is undefined before any proposeFix call — never fabricated (IMPLEMENTATION_PLAN.md telemetry spec)', () => {
    // A fake key is enough to construct the client (no network call happens at construction time)
    // — this test never calls `.proposeFix`, so it never touches the network.
    const provider = new AnthropicFixProvider({ apiKey: 'sk-test-unit-test-fake-key' });
    expect(provider.getUsageTotals()).toBeUndefined();
  });
});
