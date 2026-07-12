# ADR 009: Adoption and Agent Integration

**Status**: Accepted

## Context

A correct tool that nobody reaches for is worthless in a fix-loop context — the plan's Key Risks table
named "adoption cliff" as a top risk before any spike evidence existed. Probe 1 turned that risk from
speculative to confirmed: asked "are there architectural problems in this codebase?", a Claude Code session
with align's MCP server *available* made **zero align calls**. It used the `mast` MCP server instead —
specifically because kluster's own CLAUDE.md mandated it — plus 5 Explore subagents (~363K tokens, 4.5 min).
The decisive contrast: the agent used the tool its **project instructions told it to use**, and ignored the
one that was merely present in its tool list. **Discovery is configuration, not chance.**

The same session's outcome also settled two design questions:
- The manual survey caught the planted probe import but **missed both real cycles** align found in 2.3 s /
  <900 tokens — cycles are exactly the class of problem a broad human-style survey is bad at and a
  deterministic graph traversal is good at.
- align's tools appeared as **deferred tools** requiring explicit loading in the session — a harness detail
  that means a tool's description text is load-bearing for whether it gets discovered and loaded at all, not
  just for whether an agent chooses to call it once loaded.

## Decision

1. **`align init` writes an agent-instructions block into `CLAUDE.md`/`AGENTS.md`** (creating the file if
   absent, appending a clearly-delimited section if present): instructs the agent to run `align_check` after
   structural changes and treats red as blocking. This is promoted to a **v1 adoption-critical mechanism**,
   not optional polish — probe 1 demonstrated that tool *availability* alone produces zero unprompted usage,
   while project *instructions* produce actual usage (kluster's own CLAUDE.md → agent used `mast`
   unprompted).
2. **`align init` rule defaults lead with `no-cycles`, not `no-dependency`.** On the untouched, architecturally
   -healthy kluster repo, cycle detection found **two real latent bugs** (one in shipped UI code) while all
   three `no-dependency` rules were green — the repo genuinely honored its intended layering already.
   Cycles are the day-one value proposition; `no-dependency` rules are the regression guardrail that proves
   its worth over time, not on first run. `align init` orders its starter-rule scaffold accordingly.
3. **Inferred starter rules are ~3 layer macros, never pairwise rule dumps.** Of kluster's 8 components → 56
   ordered pairs, **49 pairs (87.5%) have zero edges today** (probe 5b) — proposing all 49 as individual
   `no-dependency` rules is overwhelm, not value. The measured edge matrix collapses naturally into ~3 layer
   statements (apps → libraries; plugins → engine; tooling isolated); `align init` generates layer macros as
   the primary scaffold output, with the seeded baseline for any inferred dependency rule measured at zero
   (every candidate is green on day one — the best possible first impression).
4. **Tool descriptions carry searchable capability keywords for deferred-loading harnesses.** Probe 1
   observed align's tools surfaced as deferred (must be explicitly loaded before use) in the session — a
   tool description that doesn't name its capability in searchable terms ("architecture rules... dependency
   constraints + cycle detection") risks never being loaded at all, independent of whether it would have
   been called once available.
5. **Zero-DSL day-one value is preserved as a design constraint even though v1 has no tool-wrapping gates
   to demonstrate it with.** `defineProject({ components })` with no `rules` callback is valid (ADR 002);
   `align init`'s baseline-seed-and-green-on-first-run flow (ADR 006) is itself a zero-authoring value
   delivery, independent of the DSL.

## Alternatives considered

- **Rely on MCP tool descriptions alone for discovery, no CLAUDE.md write.** Rejected directly by probe 1 —
  this is the exact configuration that produced zero unprompted calls.
- **`align init` proposes all pairwise `no-dependency` rules for every zero-edge component pair.**
  Rejected: 49 proposals on an 8-component repo is the "20-unsolicited-rules overwhelm" failure mode the
  plan's Two-Pass Clarification Mode (ADR 011/Stage 3) exists to prevent, applied at init time instead of
  build time — same failure, same fix (fewer, higher-signal proposals).
- **Lead `align init` defaults with `no-dependency` rules** (the plan's original framing, before the
  spike). Rejected by direct evidence: on a healthy repo, `no-dependency` rules are silent (all green,
  correctly), while `no-cycles` found real bugs — leading with the rule class that has nothing to show
  undersells the tool on first contact.

## Consequences

- `align init`'s CLAUDE.md-writing step must be idempotent and clearly delimited (e.g., HTML-comment-bounded
  section) so re-running `init` doesn't duplicate or corrupt human-authored instructions around it.
- Tool description copywriting for `align_check`/`align_violations`/`align_explain_rule` is a v1 launch
  requirement, reviewed against the "searchable capability keywords" criterion, not an afterthought.
- The starter-ruleset generator (Stage 2, `align init` layer-macro output) is scoped now: it must group the
  edge matrix into layer statements, not enumerate pairs — this is a Stage 2 implementation constraint fixed
  by this ADR, not a later design decision.

## Evidence

- Probe 1: 0 unprompted align calls; agent used the CLAUDE.md-mandated `mast` server; ~363K tokens / 4.5 min
  survey; survey missed both real cycles align found in 2.3 s / <900 tokens (spike report).
- Spike Q5 / "align init defaults" recommendation: 2 real latent cycle bugs found (one shipped) vs. all 3
  `no-dependency` rules green on the untouched repo.
- Probe 5b: 49/56 component pairs (87.5%) zero-edge; seeded baseline for inferred dependency rules measured
  at zero; matrix collapses to ~3 layer statements.
- Spike Q3: align tools surfaced as deferred tools requiring explicit loading in the session.
