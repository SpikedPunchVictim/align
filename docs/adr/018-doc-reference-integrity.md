# ADR 018: Doc-reference integrity (`docs.link-integrity`)

**STATUS: DRAFT — pending owner sign-off.** Nothing here is built. Proposes one rule + a falsification
plan; per promotion-on-evidence doctrine (`docs/proposals/rule-expansion-evaluation.md`) it ships only
if the plan clears, not on acceptance of this ADR.

> ADR numbering note: 016 (public-surface inference) and 017 (external selectors) are in flight on the
> `stage0-surface-inference` branch; this is 018 to avoid collision when the branches merge.

## Context

Documentation was the largest review-comment category in the enterprise-repo research
(`docs/proposals/documentation-consistency-exploration.md`), and ~62% of those comments are
bot-authored — the signature of LLM-generated PRs botching *structural* doc-code consistency. align's
credible slice of that space is **doc-code consistency, never prose**: an artifact that must track a
structural fact align computes, not a judgment about whether prose is good.

Two candidates were probed. This ADR is the winner — **doc-reference integrity**: a documentation file
links (relatively) to a source/doc file that does not exist, i.e. *"someone renamed/moved the file and
left the doc pointing at the old path."* The measured case (`docs/evidence/doc-consistency-probe/DOC_REFERENCE_PROBE.md`):

- Naive "does every local link resolve?" = ~10.5% broken, but **high false-positive rate** from
  docs-site routing (Docusaurus / Next-app root-relative *routes*, not files).
- **High-precision subset (relative-file links): 5.9% broken (148/2495), hand-checked.** The most
  doc-disciplined repo (backstage) is **0/1561**; broken links cluster in sloppier repos (nest 27/39,
  vscode 84/622) — the "renamed source file, stale doc link" TP recurs (vscode
  `CONTRIBUTING.md → …/agentInstructions.tsx`, otel `README.md → ./src/config.ts`).

Why this rule and not the other candidate: it is the **cheapest** (reuses `align build`'s markdown
parser + the file graph; **no** surface inference, **no** two-ref git scanning), the **broadest** (any
repo with markdown docs, not just changeset-culture ones), and it maps to the most mechanical LLM-toil
comment. The LLM-toil payoff: a dangling doc link becomes a red loop the agent fixes before a human
reviews the PR. backstage's 0/1561 is the value story — a discipline-enforcer: clean repos stay clean,
sloppy PRs go red.

## Decision

### A new `docs` gate category, with `docs.link-integrity` as its first rule

The gates today are `parse` / `architecture` / `security` (`gates/types.ts`, `GATE_KINDS`). Doc-link
integrity is neither — it is a new **`docs`** concern, and the gate is the *family*: `docs.link-integrity`
is its first member, leaving room for future doc-consistency rules (api-report freshness, public-export-
documented) without inventing a new gate each time. It is a **blocking** gate (red, agent-fixable), not
an advisory — the whole point is to stop the toil before review.

### New scanner input: a doc-link extraction pass

Doc links are **not** in the import graph — `custom.host` sees `ctx.graph` (code edges), not markdown.
So this needs a light new scan pass (distinct from, but reusing, `align build`'s markdown parsing):

```ts
// packages/core/src/types/docs.ts  (proposed)
interface DocLink {
  readonly fromDoc: RepoRelativePath;     // the .md/.mdx file
  readonly rawTarget: string;             // the link as written
  readonly kind: 'relative-file' | 'root-relative' | 'site-route' | 'anchor' | 'external';
  readonly resolved: RepoRelativePath | null; // null iff unresolvable on disk
}
```

The evaluator flags every `DocLink` of `kind: 'relative-file'` with `resolved: null`. The **high-
precision core** is exactly this subset — `./`, `../`, or a bare name with a file extension — resolved
against the scanned file set.

### Precision-critical, and where the real design work is

The probe showed the naive check's FP rate comes from two sources the rule MUST handle:

1. **Docs-site awareness.** A doc inside a Docusaurus (`docusaurus.config.*`) or Next-app
   (`app/`/`pages/` + a docs framework) tree uses root-relative *routes* (`/components/box`) that are
   not files. The classifier marks these `site-route` and does not flag them (or resolves them via the
   site's routing base if configured). This is what took backstage from "15 broken" to 0.
2. **Root-convention policy.** Subpackage-README links to repo-root files (`CONTRIBUTING.md`, `LICENSE`,
   `readme_zh.md`) are "broken as written from that dir" but a known convention. Configurable:
   flag / resolve-from-root / ignore.

Anchor validation (`#heading` exists) and code-symbol references inside docs are **out of scope** for
v1 (reserve) — the file-existence core is the measured, high-value, low-ambiguity part.

## Falsification / validation plan

1. **Reproduce the probe through the real implementation.** Run `docs.link-integrity` against the 8
   enterprise repos and confirm: the high-precision relative-file result reproduces (~5.9%), backstage
   stays at/near **0** (docs-site awareness works), and nest/vscode's real dead links are caught. If the
   real classifier can't get backstage to ~0, the docs-site heuristic is inadequate — a scope finding,
   not a silent ship.
2. **FP rate on a hand-checked sample.** Per `spike-findings.md` discipline: report precision on a
   sampled set of flagged links, not raw counts. Target: the residual FP class (extensionless site
   slugs, root-convention links) is correctly classified/configurable, not flagged as broken.
3. **Untooled-repo check.** Run against a mid-size repo without a docs framework (align's real market) —
   the probe's numbers are a floor; confirm the rule finds real dangling links there without the
   docs-site machinery getting in the way.

## Out of scope

- **Prose / wording / grammar / "explain why" / comment helpfulness** — judgment, LLM-reviewer territory,
  forever out of align's lane.
- **Anchor (`#heading`) and code-symbol references in docs** — reserve; start with file existence.
- **External URL liveness** — align is zero-network (ADR 014 posture); never.
- **Changeset⟷semver and api-report freshness** — separate candidates; the former needs two-ref git
  scanning align lacks entirely (`CHANGESET_SEMVER_PROBE.md`), a separate, larger investment.

## Alternatives considered

- **A `custom.host` predicate.** Rejected: `custom.host` receives `ctx.graph` (the *code* import graph),
  which has no markdown doc-links. Doc-link extraction is new scanner input, not expressible over the
  existing graph — so this needs first-class infrastructure, not the escape hatch.
- **Wrap an existing link checker** (markdown-link-check, lychee). Rejected: external-tool / network
  dependency against align's zero-network, pure-Node posture; and none integrate align's file graph,
  docs-site awareness, or the CI-gate / agent-loop story.
- **Advisory-only (don't block).** Rejected: the toil-reduction thesis requires a *red loop the agent
  fixes pre-PR*; an advisory a human still has to notice defeats the purpose.
- **Ship the naive "all local links" check.** Rejected on measured evidence: ~10.5% with a high FP rate
  from docs-site routing — it would cry wolf on Docusaurus/Next repos and get disabled.

## Consequences

- A new `docs` gate category (`GATE_KINDS`) and a `docs.link-integrity` rule kind (IR + evaluator +
  exhaustive-switch entries), plus a `DocLink` type.
- A light markdown-doc-link scan pass, reusing `align build`'s existing markdown parsing.
- A docs-site detection heuristic + a small `docs` rule config (root-convention policy).
- Additive: no existing gate, rule, or the import-graph scan changes.

## Evidence

- `docs/proposals/documentation-consistency-exploration.md` — the thesis, candidate family, boundaries.
- `docs/evidence/doc-consistency-probe/DOC_REFERENCE_PROBE.md` — the measured TP/FP result (5.9%
  high-precision; docs-site FP drivers; backstage 0/1561).
- `docs/evidence/doc-consistency-probe/CHANGESET_SEMVER_PROBE.md` — why the other candidate is deferred.
