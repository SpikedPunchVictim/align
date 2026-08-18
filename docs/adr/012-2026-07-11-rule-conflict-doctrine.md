# ADR 012: Rule Conflict Doctrine

**Status**: Accepted (contract) — masking/oscillation mechanics **activate once tool-wrapping gates exist**
(Stage 3/4); the precedence ordering itself is a v1-relevant fact even though v1 has only one category
populated.

## Context

align's plan treats category precedence as **normative, not just a sort order**: when rules from two
categories demand incompatible states of the same code, the higher-precedence category wins and the lower
rule yields. This matters even in v1, where only the `architecture` category is populated — the ordering
must be fixed now so ADR 007's payload priority sort and the eventual masking mechanics agree on the same
ranking, and so Stage 3/4 don't have to renegotiate a decision v1 already depends on for payload ordering.

Two distinct conflict shapes exist, and the plan is explicit that only one of them is mechanically
resolvable:
- **Shape 1 (redundant overlap)**: two rules from different tools report the *same* concern twice (e.g.,
  `arch.no-cycles` and `import/no-cycle` both fire on the same cycle). This is masking-eligible.
- **Shape 2 (true structural opposition)**: satisfying the higher-precedence rule *forces* violating the
  lower one (e.g., a layer-isolation rule requires duplication that a duplication-lint rule then punishes).
  This cannot be masked — it can only be escalated or handled with an audited, declared suppression.

## Decision

- **Normative category precedence**: `architecture > security > types > lint > format`. Higher wins; lower
  yields (suppression, config change, or scoped exemption) — never the reverse. This is the same ordering
  ADR 007 uses for payload priority sort; the two are one fact, not two decisions that happen to agree.
- **Known-overlap registry, masking, memory-only**: a static registry of IR-kind ↔ external-tool-rule pairs
  (`arch.no-cycles` ↔ `import/no-cycle`, `arch.no-dependency` ↔ `no-restricted-imports`/
  `import/no-restricted-paths`, and — if/when `arch.metric` is promoted from reserve — `arch.metric.loc` ↔
  `max-lines`, …). When a registry pair is active, the
  **lower-priority rule is programmatically masked for that run only** — adapter-level config override or
  violation filtering, **memory-only**. **align never edits external tool configs on disk**, and an agent
  never injects inline suppressions to win a rule fight. A `config-conflict` advisory still tells a human to
  reconcile the configs permanently — masking silences the symptom for the run, not the underlying
  duplication.
- **Shape-1 vs shape-2 distinction is load-bearing, not academic**: masking resolves shape-1 conflicts only.
  Shape-2 conflicts cannot be masked by construction (masking a rule that structurally *must* fire to
  protect the architecture would defeat the higher-precedence rule) — they terminate in the agent loop's
  **oscillation detection**: a fingerprint history per file where fix A introduces violation B and fix B
  reintroduces A stops the loop immediately and escalates a report naming both rule ids, rather than burning
  retry attempts ping-ponging.
- **Declared, audited suppressions for shape-2, never silent**: when a lint rule structurally opposes a
  higher-precedence architecture rule, a suppression comment may be proposed — never deleting the
  architecture-enforcing code — but only via `FixProposal.suppressions` (ADR 010), only for lower-precedence
  rules in a *detected* conflict, **never for architecture or security rules themselves**. Verification
  scans applied edits for *undeclared* disable-comments and rejects the patch — the declared list is the
  audit trail, not a suggestion.
- **Learned conflict store — reserve pointer only**: `.align/conflicts.json`, recording every escalated
  oscillation (rule pair + file context + graph shape) so a repeat occurrence is handled preemptively.
  Design Reserve (`IMPLEMENTATION_PLAN.md`) — the static registry + oscillation escalation may suffice for a
  long time; this ADR fixes precedence and masking/suppression doctrine, not the learned-store mechanics.

## Alternatives considered

- **No normative precedence — let each tool's own severity settings decide.** Rejected: tool severities are
  independently configured per tool with no cross-tool ordering guarantee; two tools both set to "error"
  gives no signal about which one encodes this project's actual intent. The plan states directly:
  "lint rules are generic heuristics; architecture rules are this project's encoded intent."
  - **Auto-editing external tool configs to resolve overlap permanently.** Rejected: align editing an
  eslint/prettier config on a user's behalf is an unreviewed, persistent side effect outside align's own
  artifacts (`.align/`) — conflicts surface as advisories for a human to resolve, matching the plan's
  explicit "align never silently edits external tool configs" principle.
- **Attempt to mask shape-2 conflicts too, by suppressing the architecture rule instead.** Rejected by
  construction — this would let a lower-priority lint rule override the project's own encoded intent, which
  inverts the entire precedence doctrine this ADR exists to state.

## Consequences

- ADR 007's payload priority sort and this ADR's category precedence must be kept as a single defined
  ordering in code (one constant, imported by both the payload builder and the future masking adapter), not
  duplicated literals that can drift.
- v1 ships this ordering with only `architecture` populated — a no-op in practice until Stage 3/4 add more
  categories, but the constant exists and is tested now so later gates don't redefine it.
- Stage 4's `FixProposal.suppressions` schema (ADR 010) is the enforcement point for the "never architecture/
  security" suppression rule — that validation lives in the apply pipeline, not in this doctrine's
  documentation alone.

## Evidence

No direct spike measurement — the spike ran a single rule category (architecture only), so no real
cross-category conflict was observed. This ADR carries the plan's precedence doctrine and shape-1/shape-2
distinction forward unchanged, scoped down to "fix the ordering and doctrine now, defer the masking
mechanics' implementation" given v1 has nothing yet to conflict with architecture rules.
