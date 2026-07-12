# ADR 001: Verification-Oracle Architecture

**Status**: Accepted

## Context

align exists to close a loop: an LLM agent edits code, then needs a trustworthy answer to "did that edit
break the architecture?" Two failure modes are possible if the answer isn't trustworthy — the agent trusts a
wrong "green" (false-green, silently ships a violation) or stops trusting a correct "red" (probe 2:
one stale verdict caused an agent to declare the tool "static/canned … not a real dependency-graph analyzer"
and permanently refuse to continue the loop). Both are worse than no tool at all, because both destroy the
thing a verification oracle sells: trust that doesn't need re-checking.

The original plan scoped v1 to wrap format/lint/types/security/tests tools behind adapters *and* build the
architecture engine simultaneously. The kluster spike's live discovery test (probe 1) tested whether an
agent reaches for align unprompted: given "are there architectural problems in this codebase?", Claude Code
made **zero align calls**, instead using the MCP server its own CLAUDE.md mandated (`mast`) plus 5 Explore
subagents (~363K tokens, 4.5 min). That survey caught the planted probe import but **missed both real
dependency cycles** align found in 2.3 s / <900 tokens; align, symmetrically, cannot see the survey's DI
violations, `as any` casts, or god files. Neither replaces the other — but the finding that matters for
scope: agents already run prettier/eslint/tsc correctly via bash without align's help. Wrapping those tools
adds no discovery-critical value in v1; architecture conformance is the one thing bash-native tooling
structurally cannot see.

## Decision

1. **Deterministic core, LLM-judgment separation**: align's engine (graph extraction, rule evaluation,
   baseline filtering) is 100% deterministic and side-effect-free over its inputs. No LLM call sits inside
   the verification path. The connected agent supplies judgment (what to fix, when to accept a proposal);
   align supplies ground truth (does the current state conform).
2. **MCP-first surfaces**: the primary integration surface is an MCP stdio server (`align mcp`), with a CLI
   as the equally-supported non-agent surface. Both surfaces render from the same `CheckRun`/`Violation`
   model — no surface-specific business logic.
3. **v1 scope is architecture-first**: v1 ships the DSL → IR → graph → rule-evaluation → violations →
   baseline → MCP/CLI pipeline only. It wraps **no** external lint/format/type/test tools. The full
   tool-wrapping gate stack (parse → format → lint → types → architecture → security → tests, declared
   `dependsOn`) stays fully specified in `IMPLEMENTATION_PLAN.md` (Stage 1/3) as the designed growth path —
   nothing is deleted, the decision is sequencing, not scope reduction.

## Alternatives considered

- **Ship tool-wrapping and architecture together in v1** (the original plan). Rejected: probe 1 shows zero
  marginal discovery value from tool-wrapping when agents already invoke those tools natively, and it
  roughly doubles v1's surface area (adapter contracts, config-fingerprinting, false-green invariant suite
  for external configs) for a capability the live test didn't need to demonstrate value.
- **LLM-in-the-loop verification** (have an LLM judge conformance directly against a prose architecture
  doc, no IR). Rejected: non-deterministic, non-cacheable, and reintroduces exactly the trust problem align
  exists to solve — a "verdict" that can't be reproduced isn't a verdict.
- **CLI-only, no MCP.** Rejected: probe 1's decisive finding is that discovery is configuration (agents use
  the MCP server their instructions mandate), not chance — an oracle an agent can't discover through its
  own tool-use loop doesn't get used regardless of correctness.

## Consequences

- v1's competitive claim is narrow and honest: cycles and dependency-direction conformance, not general code
  quality. `ARCHITECTURE.md` §6 documents this as a limitation, not a footnote.
- Every gate/payload contract (GateStatus, CheckRun, Violation) must anticipate the tool-wrapping gates that
  arrive later without a rewrite — ADR 008 fixes that contract now even though only `parse`/`architecture`
  populate it in v1.
- `align init`'s CLAUDE.md/AGENTS.md instructions block (ADR 009) becomes v1-critical, not optional polish —
  probe 1 proved availability alone does not produce discovery.

## Evidence

- Probe 1 (live discovery): 0 unprompted align calls; agent used the CLAUDE.md-mandated `mast` server;
  ~363K tokens / 4.5 min manual survey; survey missed both real cycles align found in 2.3 s / <900 tokens
  (spike report, "Live discovery test").
- Probe 2 (live fix loop + freshness): agent fixed all 3 violations correctly from tool payloads alone, then
  permanently distrusted the tool after one stale verdict from a scan-once cache (spike report, "Fix-loop
  test").
- Cold `align_check`: 2,329 ms; warm: 79 ms; 5-rule red response: 897 tokens (spike Q3/Q6).
