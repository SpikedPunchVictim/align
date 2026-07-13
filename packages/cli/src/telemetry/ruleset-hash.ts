import { sha256Hex, type RulesetIR } from '@spikedpunch/align-core';

/**
 * `rulesetIrHash` (the envelope's cross-session-comparability refinement) — reuses the exact
 * content-hash function `.align/rules.lock.json`'s divergence detection already computes with
 * (`sha256Hex`, `packages/core/src/build/hash.ts`) rather than inventing a second hashing scheme.
 * `RulesetIR` is always zod-parsed JSON with a fixed field order (ADR 002: no function-valued
 * fields, portable), so `JSON.stringify` is deterministic for a given ruleset content.
 */
export function computeRulesetIrHash(ruleset: RulesetIR): string {
  return sha256Hex(JSON.stringify(ruleset));
}
