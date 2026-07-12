# ADR 006: Baseline

**Status**: Accepted

## Context

A new rule (or align's first run) on a mature repo cannot demand global conformance on day one — that
produces a wall of red no agent or human will work through, and the plan explicitly names this the
"new rule on a mature repo" problem. The spike quantified how real this is: n8n, an untouched real-world
monorepo, surfaced **207 real runtime cycles** on its very first `arch.no-cycles` evaluation. Without
baseline machinery, align's first impression on any repo of this class is unusable — this moved baseline
from "nice to have" to a v1-critical mechanism at the re-audit.

Fingerprint stability matters as much as the existence of a baseline: if a violation's identity is
line-number-based, an unrelated edit above it (adding a comment, reformatting) changes its "identity" and
the baseline silently stops matching it — which either re-surfaces tolerated debt as new noise or, worse,
lets a genuinely new violation slip through under a stale fingerprint that happens to collide.

## Decision

- **Fingerprints are snippet-hash based, not line-based.** A `ViolationId` is derived from a stable hash of
  the violation's `snippet` (and structurally relevant fields — e.g., `fromFile`/`toFile`/`specifier` for a
  `no-dependency` violation, the cycle's edge set for `no-cycles`), not from line numbers. Edits above or
  below a violation do not change its fingerprint.
- **Move detection on prune**: `BaselineStore.prune(graph)` compares the current graph's violations against
  stored fingerprints. A fingerprint whose snippet hash matches an entry at a *different* file/line is
  classified as `moved`, not `removed` + `new` — the baseline entry transfers rather than requiring
  re-acceptance. A fingerprint present in neither old nor new set is `removed` (fixed).
- **`ruleId` is a first-class queryable field on every baseline entry**, not buried inside the opaque
  fingerprint. This enables `align baseline accept --rule <ruleId>` — accepting only violations of one rule
  while leaving all other reds red, which is the mechanism that makes incremental adoption of a *new* rule
  on an old repo tractable without a global baseline reset.
- **Consent doctrine, not silent amnesty**:
  - `align init` runs a full check; if violations exist, it seeds the baseline so `align check` exits 0
    immediately after init — no wall of red on day one.
  - **Interactive mode**: prints a loud summary ("Seeded baseline with N pre-existing violations — run
    `align baseline show`") and requires acknowledgment.
  - **Non-interactive/CI**: requires an explicit `--accept-existing` flag; without it, exits red. Silence is
    never consent.
  - **MCP never self-serves baseline acceptance by default**: `align_baseline_accept` is gated behind an
    `allowBaselineFromMcp` flag, **default false**. An agent cannot grant itself amnesty from a rule it's
    failing — baseline acceptance is a human decision surfaced through the CLI/init flow, not a tool call an
    agent can reach for under pressure to turn red green.

## Alternatives considered

- **No baseline — new repos must fix everything before `align check` is usable.** Rejected directly by
  n8n's 207-cycle evidence: this would make align unusable on any repo with pre-existing debt, which is
  most real repos.
- **Line-based fingerprints (file + line number).** Rejected: trivially unstable under unrelated edits —
  exactly the "violation fingerprint instability → baseline churn" risk named in the plan's Key Risks table;
  snippet-hash + move detection is the direct mitigation.
- **Baseline acceptance available to MCP callers by default.** Rejected: an agent under pressure to reach
  green has a direct incentive to call an unrestricted `align_baseline_accept` instead of fixing the
  violation — this is a variant of the "green ≠ correct" risk, applied to the baseline mechanism itself
  instead of a code edit. Default-off requires a human to opt in per-project.
- **Global-only baseline (no `--rule` scoping).** Rejected: without rule-scoped acceptance, adopting a
  *new* rule on an already-baselined repo forces either a second global reset (re-hiding everything, losing
  granularity) or blocks the new rule from shipping — `--rule` decouples "accept this rule's existing debt"
  from "accept everything."

## Consequences

- Every `Violation` must carry enough structural information (`snippet` plus kind-specific fields) to
  produce a stable hash — this is why `snippet` and per-edge cycle detail are Violation-model requirements,
  not payload nice-to-haves (cross-reference ADR 007, `docs/core-interfaces.md`).
- `align init` on n8n-shaped repos (207+ day-one violations) is a baseline-seed-and-continue flow by design,
  not an error state — success criteria for Stage 1/2 must test this path explicitly, not just the
  clean-repo path.
- `baseline accept --since <commit>` (worktree-diff based) stays Design Reserve — `--rule` covers the
  practical adoption need observed so far; `--since` adds a temporary-worktree implementation cost with no
  evidence yet that `--rule` is insufficient.

## Evidence

- n8n: **207 real runtime cycles** found on the untouched repo's first `arch.no-cycles` evaluation (probe
  4) — "makes baseline machinery a v1 prerequisite, not a nice-to-have."
- Kluster, by contrast: 0 pre-existing violations across the 4 real rules (3 `no-dependency` + `no-cycles`
  found only the 2 real bugs) — the two repos together show baseline must handle both "clean" and
  "200+ violations" as first-run outcomes.
