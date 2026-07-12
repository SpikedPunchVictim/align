/**
 * `FixProvider` — the injected boundary between the state machine and any LLM (CODING_BEST_PRACTICES.md
 * §14/15, per the task's explicit framing): the state machine is a pure decision core that never
 * imports `@anthropic-ai/sdk`; it only ever sees this interface, which any fake can implement in
 * tests. `AnthropicFixProvider` (anthropicFixProvider.ts) is the one real implementation.
 */
import { sha256Hex, type RepoRelativePath, type RuleId, type Violation } from '@align/core';
import type { FailureContext, FixProposal } from '@align/core';

export interface RuleExplanation {
  readonly ruleId: RuleId;
  readonly kind: string;
  /** `.because()` / doc-quote provenance (ADR 002/011) — included verbatim so the LLM sees the
   * project's own stated rationale, not a paraphrase. */
  readonly because?: string;
}

export interface SymbolTableEntry {
  readonly file: RepoRelativePath;
  readonly exports: readonly string[];
}

export interface FixProviderInput {
  /** Structured violations for one GROUP (all of one file's violations, per ADR 010/plan). */
  readonly violations: readonly Violation[];
  /** The grouped file(s)' current content — search blocks must match this exactly. */
  readonly fileContents: ReadonlyMap<RepoRelativePath, string>;
  /** Importable symbols from the graph — exports of files the target may import. */
  readonly condensedSymbolTable: readonly SymbolTableEntry[];
  readonly ruleExplanations: readonly RuleExplanation[];
  /** Present only on a REPAIR retry — the apply pipeline's rejection reason + re-anchoring context. */
  readonly previousFailure?: FailureContext;
}

export interface FixProvider {
  proposeFix(input: FixProviderInput): Promise<FixProposal>;
}

/** Canonical, order-independent serialization of a `FixProviderInput` for memoization hashing. */
function canonicalize(input: FixProviderInput): string {
  const files = [...input.fileContents.entries()].sort(([a], [b]) => a.localeCompare(b));
  const violations = [...input.violations]
    .map((v) => ({ id: v.id, ruleId: v.ruleId, file: v.file, range: v.range, snippet: v.snippet }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const symbols = [...input.condensedSymbolTable]
    .map((s) => ({ file: s.file, exports: [...s.exports].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const explanations = [...input.ruleExplanations].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  return JSON.stringify({ files, violations, symbols, explanations, previousFailure: input.previousFailure ?? null });
}

export function hashFixProviderInput(input: FixProviderInput): string {
  return sha256Hex(canonicalize(input));
}

/**
 * Wraps any `FixProvider` with in-memory, per-run memoization by `hash(input)`. A `FixProposal` is
 * a pure function of its input in spirit (ADR 010: "preserves pure-function memoization
 * semantics") — an identical GROUP + identical `previousFailure` context should never re-invoke
 * the underlying provider (saves cost, and makes REPAIR retries with unchanged state a no-op
 * instead of an infinite-cost loop).
 */
export class MemoizingFixProvider implements FixProvider {
  private readonly cache = new Map<string, Promise<FixProposal>>();
  private callCount = 0;

  constructor(private readonly inner: FixProvider) {}

  async proposeFix(input: FixProviderInput): Promise<FixProposal> {
    const key = hashFixProviderInput(input);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    this.callCount += 1;
    const promise = this.inner.proposeFix(input);
    this.cache.set(key, promise);
    // Never memoize a rejection — a transient failure shouldn't poison the cache for this run.
    promise.catch(() => this.cache.delete(key));
    return promise;
  }

  /** Test/observability hook — number of calls that actually reached the inner provider. */
  get providerCallCount(): number {
    return this.callCount;
  }
}
