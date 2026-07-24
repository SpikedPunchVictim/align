# Exploration: can align improve the development loop (not just the PR)?

**Status: exploration, not a proposal to build.** Forward ideation — unlike the PR-front work, there is
no mined evidence *yet*; the point of this doc is to name the highest-leverage direction and the probe
that would validate it before any build.

## The reframe: prevention > detection

The PR-front is closed out (`pr-research/FINDINGS_CONSOLIDATED.md`): align credibly owns the ~10%
architectural slice and already ships most of it. But everything on that front is **detection** — catch
a violation *after* an agent wrote it, costing at least one check→fix→recheck cycle, often several.

The dev-loop opportunity is to move to **prevention**: align uniquely holds the thing an agent lacks
when it lands in a codebase — a machine-readable model of the *intended* architecture. Today that model
only speaks when something is already wrong. If it spoke *before* the edit, the agent wouldn't create
the violation in the first place. Fewer iterations, tighter loop.

**The economics — and why this is on-brand, not drift.** The benefit is not just "one fewer
iteration." Every reactive check→fix cycle re-spends tokens: the agent re-reads context, re-plans,
re-edits, and its context window bloats with the failed attempt. Prevention front-loads a small,
targeted context payload to avoid the whole retry — so the real, measurable win is **net tokens (and
latency) to green**, which compounds with every avoided cycle. This is a direct extension of align's
existing token-economy discipline: ADR 007 already optimizes tokens on the *reactive* side (compact
structured violation payloads, not prose; pull-on-demand explanations). "Proactive, not reactive"
applies the same competency on the *front* end — inject the **minimal** architecture facts governing
the files in play, not an architecture dump. align is the one tool positioned to do this cheaply
*because* ADR 007 already made it disciplined about payload size. **align should operate proactively,
not reactively — prevention is the natural end state of a token-economy oracle.**

The honest counterweight to measure (below): the injected context is not free. Net token savings =
(tokens saved avoiding retries) − (tokens spent injecting context). It nets strongly positive only if
the injection stays minimal and targeted (align's ADR-007 strength) while retries are expensive (full
re-plan/re-edit). The probe measures the *net*, not the gross.

## Levers, ranked by leverage × align-fit

### 1. Architecture context to the agent, before it writes (the big one)
An MCP resource/tool that, given the file(s) an agent is about to touch, returns: the component/layer it
belongs to, what it may and may not depend on, what depends on *it*, and the governing rules — *ahead*
of the edit. align already computes all of this; it just surfaces it post-hoc as a violation. Packaging
it as pre-flight context converts "agent writes forbidden import → align rejects → retry" into "agent
knows the boundary and writes it right." Most thesis-consistent, and **testable** (see the probe).

### 2. Impact / blast-radius analysis (`align check --changed` + "what depends on this")
From the graph align already builds: (a) scope a check to the diff's impact — tighter, faster loop on
big repos (the `--changed` mode the plan sketched); (b) answer "if I change this module's public
surface, what's the blast radius?" *before* the change (reuses ADR-016 surface). Kills the "didn't
realize this was load-bearing" class.

### 3. Rule-authoring & anti-staleness assist (the adoption-friction lever)
align's *rules* must be written and kept current; stale rules degrade the loop — we watched this bite
(kluster's stale brace-glob selector errored the whole check this session). Two moves: (a) suggest
candidate rules from observed structure ("these two components never import each other today — enforce
it?"), lowering the config barrier; (b) extend `align doctor` (already flags dead aliases / ungrounded
components) to keep rules from rotting as the codebase evolves.

### 4. UX polish of align-as-oracle (already underway)
The clearer `agent run` gate-error message and pretty-printed `check` output shipped this session were
dev-loop improvements — the loop is only as good as how legibly align communicates. Speed (incremental
scan), richer fix-hint recipes, and posting violations as inline PR comments live here. Incremental, no
identity risk.

## What git history tells us about dev-loop friction (metrics)

Archival git metrics *size the problem* prevention would address. First-pass numbers (recent commits,
5 repos):

| repo | reverts (loop-failed) | fix-churn | renames (structural moves) | **cross-pkg commits (coupling)** |
|---|--:|--:|--:|--:|
| backstage | 0.6% | 9.2% | 6,398 | 12.3% |
| n8n | 0.0% | 41.9% | 8,440 | **27.4%** |
| directus | 0.7% | 2.4% | 3,503 | 9.7% |
| nest | 0.4% | 24.4% | 1,804 | 3.2% |
| strapi | 0.5% | 40.3% | 15,592 | 20.6% |

Read (corrected after review — most of this first pass does NOT survive scrutiny):
- **Reverts (~0.5%)** — meaningful and correctly read: the loop's cost is *iterations to green*, not
  bad merges. Keep.
- **fix-churn — DROP.** The 2.4%→41.9% spread is a commit-message-convention / squash-policy artifact,
  not a friction differential. Not an architecture signal; shouldn't be in the table.
- **Renames (raw counts) — NOT interpretable as printed.** Unnormalized across repos of different
  size/age and dominated by one-off mass-move episodes. Would need *rename-episodes per 1K commits*.
- **Cross-package commit rate — confounded, not "coupling."** n8n/strapi are many-small-package
  monorepos where any feature legitimately crosses; it measures *how sliced the monorepo is*, not how
  much friction boundaries cause. As printed it over-claims.

**The align-shaped metric this first pass MISSED (worth actually collecting):**
- **Logical (co-change) coupling joined against align's rule/dependency graph.** Per component-*pair*,
  P(B changes | A changes) from `git log --name-only` + component mapping; then intersect with the
  declared graph. **Pairs that co-change often but have NO declared dependency path = hidden coupling
  align's rules should govern** — this converts the "27% cross-package noise" into a targeted
  rule-candidate list and feeds lever 3a directly. ~a day's work, and it's the metric that uses what
  only align has (the rule model).
- Secondary, also computable: boundary-file churn concentration (churn share of ADR-016 public-surface
  files vs. internals); fix-crosses-boundary rate (does a correction land in a *different* component
  than the thing it fixed = ripple); blast-radius distribution (files/packages per commit) as the prior
  for lever 2b.

**Correction to the mining-vs-experiment claim.** Half-right. Git alone cannot capture agent-loop
check→fix cycles — true. But these are public GitHub repos: **PR review-round counts, CI check-run
pass/fail/re-run histories, and force-push events are queryable via the API** — "iterations-to-green"
*at PR granularity* exists archivally. That's a mid-cost rung the first draft skipped. Only the
*counterfactual* ("would pre-flight context have prevented this") and the agent-loop iteration count
genuinely need the experiment.

## The prevention probe — corrected sequencing

**Stage 0 (do this FIRST — cheap, decisive-if-negative): measure the base rate `p`.** Run only the
control arm (or just run `align check` over diffs from any existing agent-task corpus) and measure the
**first-pass architecture-violation rate**. Prevention's entire gross upside is ~897 tokens × `p` per
task (ADR 007's measured red-check cost). If `p` is low, there is nothing to prevent and the treatment
arm is wasted — the doc-consistency probe (0.2% base rate → shelved, FINDINGS #1) is the house
precedent. align's own token-economy doctrine (ADR 007: "every payload is a recurring cost paid on
every iteration") cuts *against* prevention here, because pre-flight context is paid on every edit
while the ~897-token check is paid only when a violation exists. So the base rate must clear a real bar
before building anything.

**Stage 1 (only if `p` clears the bar): the three-arm experiment.**
- **Control:** agent + `align check` in the loop (today's setup).
- **Placebo:** agent + check + a generic nudge ("this repo has align rules; mind package boundaries")
  with NO computed context — isolates *salience* from *information*. If placebo ≈ treatment, the finding
  is "add a CLAUDE.md line" (which `align init` already does, ADR 009), **not** "build an MCP resource."
- **Treatment:** agent + check + computed pre-flight context (lever #1).

Primary metric: **net total tokens to green** (treatment's injection cost included — the economic claim
stands or falls here). Secondary: first-pass violation rate, iterations-to-green, latency. Guardrails:
report a *naturalistic* task set alongside the curated architecture-touching one (curated tasks inflate
`p` by construction — fine for existence, invalid for sizing); agent runs are high-variance, so
repetitions per task and report distributions, not means.

## Boundaries (the discipline)
Not: general code intelligence / autocomplete (the LSP's job), test running, build orchestration, or the
editor-LSP lane (priced earlier as multi-quarter, poor ROI vs. the agent-loop path). align improves the
loop as the *architectural oracle*, not by becoming an IDE.

## Recommendation — corrected priority (post-review)

The original draft ranked lever #1 first; that was ranking by *thesis-flattery* (most align-unique),
not by leverage. Corrected order:

1. **Ship 4 + 2a — make the existing detection cycle near-free and never-wrong.** Incremental
   `--changed` checks, fix-hints good enough for one-pass repair, output legibility. Paid on *every*
   iteration (loop cost = iterations × cost-per-iteration; align fully controls the second factor, and
   ADR 007's 3.6x payload win proves this class compounds), no discovery problem (lives in the check
   path the agent already calls), no identity risk. This is the real win.
2. **Harden lever 3 (anti-staleness).** The only lever with an *observed* dev-loop failure this session:
   kluster's stale brace-glob selector `error`ed the whole check, and per ADR 008 an `error` halts the
   loop and escalates to the human — maximum friction. A rotting oracle gets routed around; nothing else
   matters then.
3. **Mine co-change-vs-rule-graph coupling** (the metric above) — cheap, feeds rule-suggestion (3a).
4. **Measure the base rate `p`** (probe Stage 0).
5. **Only then decide whether lever #1 earns its full experiment.** The token-economy argument makes #1
   *worth measuring*, but ADR 009's probe-1 result (available MCP tool → zero unprompted calls) means
   its viable form (pull-based, CLAUDE.md-mandated) is in tension with its identity-safe form
   (declarative, not push-injected loop-orchestration). That tension is unresolved and belongs in the
   experiment's design, not ahead of it.

Net: the boring levers are the win; #1 is a research bet, correctly gated behind a base-rate measurement.
