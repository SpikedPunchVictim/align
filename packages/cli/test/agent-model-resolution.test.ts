import { describe, expect, it } from 'vitest';
import { resolveAgentModel } from '../src/commands/agent.js';

/**
 * The payoff of moving `ALIGN_AGENT_MODEL` out of `AnthropicFixProvider`'s constructor and up to the
 * CLI entry point: the precedence is now a pure function of its arguments, so these four cases exist
 * at all. While the read lived inside the provider, the env branch had **no test in the repository** —
 * exercising it would have meant mutating `process.env` inside a test and hoping nothing else in the
 * worker process noticed.
 *
 * Same shape as `resolveTelemetryPreConfig`, deliberately: align now has exactly two environment
 * variables, both resolved by a named function with an injectable env, both called only from
 * `program.ts`. The rule that keeps it that way is executable in
 * `packages/agent/test/agent-reads-no-ambient-env.test.ts`.
 */
describe('resolveAgentModel — flag beats env beats the provider default', () => {
  it('prefers the explicit --model flag over the environment', () => {
    expect(resolveAgentModel('claude-opus-5', { ALIGN_AGENT_MODEL: 'from-env' })).toBe('claude-opus-5');
  });

  it('falls back to ALIGN_AGENT_MODEL when no flag was passed', () => {
    expect(resolveAgentModel(undefined, { ALIGN_AGENT_MODEL: 'from-env' })).toBe('from-env');
  });

  it('returns undefined when neither is set, so the provider applies its own default', () => {
    // Deliberately NOT resolving the default here: the model default belongs to the provider that
    // calls the API, and duplicating it at the CLI boundary would give align two places to change it.
    expect(resolveAgentModel(undefined, {})).toBeUndefined();
  });

  it('treats an empty ALIGN_AGENT_MODEL as unset rather than as an empty model id', () => {
    // `ALIGN_AGENT_MODEL=` in a shell profile or a CI matrix entry is how a variable gets "unset" in
    // practice. Passing '' through would reach the SDK as a model id and fail at the API boundary
    // with a message about the model rather than about the configuration.
    expect(resolveAgentModel(undefined, { ALIGN_AGENT_MODEL: '' })).toBeUndefined();
  });
});
