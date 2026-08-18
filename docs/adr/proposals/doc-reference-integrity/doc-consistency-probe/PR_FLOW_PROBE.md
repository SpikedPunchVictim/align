# Probe: PR-FLOW — do changes actually introduce dangling doc links?

**This is the probe that tests the actual thesis.** Everything prior measured repo *stock* (broken
links sitting at HEAD). The doc-reference-integrity value proposition is about *flow* — a change
*introducing* a dangling link, caught as a red loop before a human reviews the PR. Fable's ADR-018
review correctly flagged that no probe had tested this. This one does.

## Method

Sampled the **400 most recent doc-touching commits per repo** across 6 repos (2,400 commits). For each
commit that ADDS a relative-file markdown link (high-precision filter: has a file extension, not
`node_modules`, not `.claude`/`.github`/agent-scratch docs), resolve the added link **against that
commit's own tree** (`git cat-file -e <commit>:<path>`). A link that doesn't resolve = dangling *at
introduction*. Then classify each dangling link by whether its target exists **anywhere** in the repo
at that commit.

(Caveat: these repos squash-merge, so a commit ≈ a PR; for any multi-commit PRs a link whose target
arrives in a sibling commit would look dangling here but resolve at merge — so the real-dead rate below
is an upper bound, if anything lower.)

## Result

**31 of 112 doc-link-adding commits (27%) shipped a "dangling" link** — but the classification guts it:

| class | count | % of dangling links |
|---|--:|--:|
| **TRANSLATED-README** (`readme_zh.md`/`_kr`/`_jp` — one repo, nest, one convention) | 173 | **88%** |
| **CONVENTION** (target exists *elsewhere* — subpackage README → root `CONTRIBUTING.md`/`LICENSE`) | 19 | 10% |
| **REAL-DEAD** (target exists *nowhere* in the repo) | **5** | **3%** |

The genuine defect — a change introducing a link to a file that exists nowhere — is **5 instances
across 2,400 commits (~0.2% of doc-touching commits)**, and even those are weak:
`stylelint-config/README.md → ../../../proposal.md`, `tests/e2e/README.md → ../../AGENTS.md`,
`container.mdx → strapi.mdx` (a Docusaurus sibling that likely resolves via routing),
`readme_zh.md → readme.md`.

## Verdict — the thesis does not hold at meaningful scale (this evidence)

The **flow** rate looked high (27%) but is **88% one convention in one repo** (nest's translated
READMEs) plus 10% subpackage-to-root convention. The marquee case that motivated the whole direction —
*"an LLM renames a file and leaves a dangling doc link"* — **did not appear at scale in commit flow.**
Both measures now agree the genuine defect is rare: stock ≈ 2.6% (Fable's re-analysis), flow real-dead
≈ 0.2% of doc-touching commits.

Per promotion-on-evidence doctrine, **this candidate does not clear the bar to build.** The decisive
probe came back weak; that is the probe doing its job.

## Honest caveats (what could still change the call)

- **Elite-OSS sample.** These repos have mature doc discipline. Untooled repos likely have more broken
  *stock* — but this probe measured *flow*, and even the flow of genuine dead links is negligible here.
- **Not LLM-PR-specific.** The thesis is about *LLM-generated* PRs; this sample is general commit flow
  (human + some bot). I have no LLM-PR corpus to isolate. It's possible LLM PRs introduce dead links at
  a higher rate — but that is now an *unmeasured assumption*, not evidence, and should not be
  hand-waved into a build decision.
- **File-existence only.** This does not measure the harder "doc says the old behavior after a code
  change" drift, which is mostly judgment anyway (out of align's lane).

## Recommendation

**Do not build doc-reference integrity now; move it to Design Reserve** with an explicit promotion
trigger: a *specific adopter* (e.g. an align user running it on their own repo/CI) demonstrating that
dangling doc links are a real, recurring problem *for them* — i.e. real demand, not enterprise-repo
inference. If that trigger fires, the leanest form Fable prescribed (an additive `HostRuleContext.docLinks`
capability + a `custom.host` recipe, no `docs` gate category, no site-route machinery) is the shape to
build — but the evidence to justify even that is not here today.

**ADR 018 should be marked superseded / Design-Reserve accordingly.**
