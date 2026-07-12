# Rule Vocabulary Expansion — Evaluation

**Status**: Proposal — no code, plan, ADR, or config changes in this document. Every recommendation below
is advisory; promotion decisions remain the user's per `IMPLEMENTATION_PLAN.md`'s promotion-on-evidence
doctrine ("the burden of proof is on *promotion*, not on the mechanism already being designed").

**Scope**: two independent threads. (A) close the gap between align's rule vocabulary and ArchUnitTS's, the
project's closest architecture-testing analog. (B) design the vocabulary for supply-chain / package-poisoning
security rules, a category align has designed a slot for (`Category = '... | security | ...'`,
`security.secrets`/`security.tool` reserved discriminants) but never populated or evidence-tested.

**Two corrections made during research, both material to the recommendations below**:

1. **`custom.host` is not usable today.** Per commit `064edaf` (relayed mid-task): the DSL never implemented
   a `custom` factory, and pre-fix, `evaluateRule` silently returned zero violations for `custom.host` — a
   passing-by-omission false-green. Verified directly against `packages/core/src/rules/host-rules.ts` and
   `packages/core/src/orchestrator.ts:86` (`validateHostRules(this.ruleset.rules, new Set<string>())` — an
   **always-empty** registered-predicate set): every `custom.host` rule now hard-errors at check time
   (`UnknownHostRuleError`), because nothing is, or can be, registered. `custom.host` is reserve-in-practice,
   not an escape hatch anyone can reach for. This directly affects Thread B's "expressible today" analysis.
2. **The scanner does not currently record external-package edges.** The originating brief for this
   evaluation assumed "the scanner already records which components import which EXTERNAL packages." Verified
   against `packages/plugin-typescript/src/scanner.ts:228-229`:
   ```ts
   case 'external':
     return; // external packages are not graph nodes; DependencyGraph doesn't track them
   ```
   Every external specifier is resolved, classified, and then **discarded** — zero edges, zero uncertainty
   markers, nothing retained. This is a small, well-understood change (the resolution and classification
   already happen; only the discard needs to become a push), not a new scan domain — but it is **not built**,
   and any "expressible now" claim in Thread B is corrected accordingly.

---

## Executive summary

**Tally** (23 evaluated items, consolidated table at the end): **1 promote-now**, **11 reserve-with-trigger**,
**11 reject-with-reason**. Zero *new rule kinds* clear the bar the project sets for itself elsewhere (LOC's promotion
needed two independently confirmed 2,000+-line files from a live ruleset exercise, plus explicit user
sign-off) — Thread A has one real but single-instance gap and several ArchUnitTS capabilities align already
declines by design; Thread B is evidence-poor by the project's own standard, because unlike architecture,
**no security-analog of the Stage S kluster/n8n spike has ever been run**.

**Top 3 recommendations**:

1. **Run a manifest-security probe before promoting any Thread B rule** — a Stage-S-shaped exercise against
   align's own `package.json`/lockfile plus kluster's and n8n's, scoped to the cheapest, fully-offline
   manifest rules (§B.2). This is the single highest-leverage next step: it converts "threat-landscape
   evidence" (real but generic) into the repo-specific evidence this project's promotion doctrine requires.
2. **Build the `custom.host` registration surface** (§B.0) — the one item in this document with evidence
   that already exists (the HIGH-severity false-green finding, fixed defensively but not functionally, in
   commit `064edaf`). This is infrastructure, not a new rule kind, and it is the cheap path several other
   candidates in both threads currently lean on and cannot actually use.
3. **Do not build class-level metrics (LCOM, method/field counts) or Nx-specific rules yet** — both are real
   ArchUnitTS capabilities align lacks, but neither has any repo-demonstrated demand, and both require model
   changes (class-level graph nodes; a second manifest format) disproportionate to the evidence on hand.

---

## Thread A — ArchUnitTS gap matrix

Source: `https://lukasniessen.github.io/ArchUnitTS/` (fetched; returned a WebFetch-summarized catalog, not raw
HTML — noted per-item where a subpage 404'd/503'd and the GitHub README, `github.com/LukasNiessen/ArchUnitTS`,
was used as the fallback per this task's instructions). ArchUnitTS is a TypeScript-native architecture-testing
library, the closest existing tool to align's own DSL-testing shape.

### A.1 Capability × coverage matrix

| ArchUnitTS capability | align status |
|---|---|
| `haveNoCycles()` (folder/project cycle detection) | **Has it** — `arch.no-cycles` (Tarjan SCC, per-edge chain detail) |
| `dependOnFiles()` / layer direction rules | **Has it** — `arch.no-dependency`, `arch.layers` |
| `metrics().count().linesOfCode()` | **Has it** — `arch.metric` (`loc`, promoted 2026-07-12) |
| `allowEmptyTests` guard (fails on 0-match selectors by default) | **Has it, arguably first** — empty-selector-fails-by-default (ADR 003), spike-evidenced before ArchUnitTS parity was even checked |
| `withName()` / `inFolder()` / `inPath()` ad hoc glob/regex matching per rule | **Expresses differently, by design** — align routes all selection through the components registry (ADR 003); ad hoc raw-glob rule authoring was explicitly rejected as the selector-drift failure mode |
| `projectSlices()` (dynamic folder-pattern slices with wildcard capture groups) | **Expresses differently, with a real sub-gap** — align's components are static named selectors, not capture-group-derived; see §A.2.2 (sub-path scoping) |
| `haveName()` (file naming pattern) | **Genuine gap** — `arch.naming` reserved, unimplemented; see §A.2.1 |
| Class naming regex | **Genuine gap** — same reserve, narrower (align has no class-level AST pass at all) |
| `adhereTo(customFn)` (arbitrary custom rule predicate) | **Genuine gap, currently unusable on align's side** — align's structural analog (`custom.host`) is schema-only; see §B.0 |
| Custom metrics (arbitrary calc function) | **Genuine gap**, same mechanism as above |
| LCOM96a / LCOM96b (class cohesion) | **Genuine gap** — needs class-level AST + method/field usage graph; see §A.2.6 |
| Method count / field count / statement count (class-level) | **Genuine gap**, same class-level-node prerequisite as LCOM |
| Abstractness / instability / coupling factor / distance-from-main-sequence | **Reserved, unimplemented — direct name-for-name parity with align's own reserved `fan-in`/`fan-out`/`instability`** (`docs/ir-schema.md`) |
| `adhereToDiagram()` (PlantUML conformance) | **Genuine gap, but doctrinally dispreferred** — align already has a better-fit mechanism (ADR 011's markdown-as-buildable-intent-source); see §A.2.5 |
| `nxProjectSlices()` (Nx project cycles/boundaries/tag rules) | **Genuine gap, zero evidence base** — align has never been validated against a real Nx repo; see §A.2.4 |
| Dependency graph exports (DOT/D2/CSV/HTML) + HTML metric dashboards | **Out of scope for this evaluation** — reporting/tooling, not rule vocabulary; align's Mermaid-on-demand (ADR 007) is a deliberate token-economy-motivated subset, not a gap |
| Jest/Vitest/Jasmine/Mocha test-runner integration + caching | Not comparable — align is not a test-runner-embedded library; orthogonal design point |

### A.2 Genuine-gap assessments

Each assessed on: (1) analysis level, (2) deterministic-oracle + token-economy doctrine fit, (3) demand
evidence, (4) recommendation.

#### A.2.1 `arch.naming`

- **Analysis level**: cheap — filename/path regex, no new scan domain (class-naming variant would need the
  same class-level AST pass as §A.2.6).
- **Doctrine fit**: good — deterministic, portable, cheap to explain.
- **Evidence**: weak and already litigated. `test-apps/kluster/RULESET_REPORT.md` §6.3 found 9 files with
  duplicated inline error-rendering markup and explicitly concluded this "is closer to a **duplication/
  consistency** finding than a pure **naming** one" — the project's own promotion log (`IMPLEMENTATION_PLAN.md`)
  already recorded this as *not* naming evidence when `arch.metric` was promoted alongside it.
- **Recommendation**: **reserve-with-trigger, unchanged.** Trigger: a repo demonstrating a genuine naming
  violation (e.g., a convention like "files exporting a React error boundary must be named
  `*ErrorBoundary.tsx`") independent of the duplication smell already logged and rejected as naming evidence.

#### A.2.2 Component sub-path scoping (ArchUnitTS's dynamic slices, align's static components)

- **What it is**: ArchUnitTS's `projectSlices().definedBy('src/(**)/')` derives slice names from a wildcard
  capture group — a rule can address "each top-level folder under `src/`" without naming each one. align's
  components are hand-declared, flat, and do not compose (no "this component minus this sub-path" operator).
- **Evidence, concrete and already logged twice**: the live `align_propose_rules` session against kluster
  (`IMPLEMENTATION_PLAN.md`, Stage 3 status) explicitly hit this: the agent "noticed the just-promoted
  `metric.loc` and correctly ruled it out for route-handler thinness (**sub-path scoping gap**)" — i.e., it
  could not express "files under `api-app`'s `routes/`, excluding `test/`, stay under N lines" because
  `arch.metric`'s `target` is a whole `ComponentRef`, not a sub-path within one. `RULESET_REPORT.md` §9 item 1
  independently logs the same route-handler-thinness constraint as needing either a promoted structural-shape
  kind or a working `custom.host` predicate — the doc calls both instances "confirmed rule-kind gaps."
- **Analysis level**: cheap — this is a DSL/IR selector-composition change (e.g., an `exclude` glob array on
  `ComponentDefinition`, or a derived/nested component), not new scanning; every input already exists in the
  `DependencyGraph`.
- **Doctrine fit**: good — stays deterministic, portable, and doc-buildable exactly like existing component
  selectors.
- **Recommendation**: **reserve-with-trigger, but the closest call in Thread A to promote-now.** It is real
  (not hypothetical), cheap, and already independently confirmed twice in the same live session — but it is
  still a single session's evidence, and the project's own bar for `arch.metric`'s promotion was two
  *separately confirmed* real files, not one session's worth of friction. Trigger: a second independent
  session or repo hitting the same scoping wall, **or** a maintainer judgment call that the cost is low
  enough not to require a second confirmation (this is exactly the kind of call this document is not
  positioned to make on the user's behalf).

#### A.2.3 Duplication / structural-clone detection

- **What it is**: ArchUnitTS has no dedicated duplication rule either, but the underlying capability class
  (detecting near-identical code across files) is adjacent to what `arch.naming` would need to catch
  kluster's 9-file error-UI duplication.
- **Evidence**: `RULESET_REPORT.md` §6.3 explicitly grades this "**plausible, weaker evidence**" and concludes
  the fix is more naturally "add a shared `ErrorState` component and a lint/AST rule enforcing its use" than
  a new align rule kind as currently scoped — the project's own report already leans against building this.
- **Analysis level**: new scan domain — cross-file content/AST similarity. Two very different sub-variants
  with different doctrine fit:
  - **Exact structural-clone hashing** (AST-shape hash equality across files) — deterministic, cacheable,
    fits the oracle doctrine.
  - **Fuzzy near-duplicate detection** (similarity thresholds) — inherently probabilistic; a violation that
    depends on a tunable threshold is not the kind of "the code either does or doesn't violate" verdict the
    false-green doctrine is built around.
- **Recommendation**: **reject-with-reason for the fuzzy variant** (doctrine conflict, not a capability gap
  — a threshold-based rule cannot offer the binary trust guarantee ADR 001 demands). **Reserve-with-trigger for
  the exact-clone variant**, trigger: a repo showing multiple *byte-for-byte-modulo-whitespace* identical
  structures, which the current evidence (9 files, described as duplicated *pattern*, not verified as
  identical structure) does not yet establish.

#### A.2.4 Nx-specific rules (`nxProjectSlices()`, project-graph cycles/boundaries, tag-based type validation)

- **Analysis level**: new scan domain — Nx's project graph (`project.json`/`nx.json`, workspace tags) is a
  distinct manifest format from `pnpm-workspace.yaml`, which is the only workspace format align currently
  parses (`packages/plugin-typescript/src/workspace.ts`).
- **Doctrine fit**: fine in principle — once translated to align's graph model, project-boundary rules are
  structurally identical to `arch.layers`.
- **Evidence**: **none.** align's entire validation history (spike + n8n + kluster + align-on-itself) is pnpm
  workspaces. The two concrete false-green fixes that *did* ship — realpath classification and the
  workspace-name resolver fallback — only existed because a real pnpm repo (kluster) exposed them; there is no
  analog for Nx because no real Nx repo has ever been run through align.
- **Recommendation**: **reject-with-reason** (no evidence base, and the format-specific bugs align has
  historically found are exactly the kind that only surface against a real repo of that kind). Trigger for
  revisiting: external validation against a real Nx monorepo, mirroring how kluster/n8n validation drove every
  other v1 graph-extraction decision.

#### A.2.5 UML/PlantUML diagram conformance (`adhereToDiagram()`)

- **What it is**: define the intended architecture as a PlantUML diagram; ArchUnitTS asserts the real
  dependency graph matches it.
- **Doctrine fit**: **conflicts.** align already has a doctrinally preferred mechanism for "intent expressed
  in a human-authored artifact, mechanically checked" — ADR 011's markdown-as-buildable-intent-source
  (`align build`), which additionally provides provenance (`sourceFile`/`sourceLineRange`/`sourceQuote`),
  section-hash reproducibility, a precision ladder, and impact-delta dry-run gates. A UML-diagram-as-source
  mechanism would duplicate this without any of that machinery, and would introduce a second "intent format"
  the project has no other reason to support.
- **Recommendation**: **reject-with-reason.** ADR 011 already covers the underlying need better than the
  ArchUnitTS mechanism would.

#### A.2.6 Class-level metrics: LCOM96a/96b, method count, field count, statement count

- **Analysis level**: new scan domain and a **new graph granularity** — align's `DependencyGraphNode` is
  file-level (`docs/core-interfaces.md`); LCOM requires knowing, per class, which methods touch which fields,
  which means parsing class bodies, not just import statements. This is a materially larger scanner change
  than anything else in this document — align would need class-level nodes (or a class layer bolted onto the
  file-level graph) before any of these metrics could be evaluated.
- **Doctrine fit**: fine in the abstract (deterministic, once a class model exists) but in tension with the
  file-level model ADR 004 deliberately committed to for performance reasons (scan-and-discard, 2.2 s /
  136 MB on 456K LOC) — class-level parsing is not free at that scale, and hasn't been measured.
- **Evidence**: **none directly on point.** The closest signal is `IMPLEMENTATION_PLAN.md`'s Stage S note that
  the 363K-token manual survey (probe 1) flagged "god files" that align's file-level rules missed at the
  time — but LOC's promotion already absorbs the size-based half of "god file," and no repo evidence
  distinguishes a *large-but-cohesive* file (which LOC correctly flags) from a *small-but-incohesive* one
  (which only LCOM would catch and LOC would miss).
- **Recommendation**: **reject-with-reason** for now — no evidence justifies the graph-granularity change.
  Trigger: a repo demonstrating a real LOC **false negative** — a file under the LOC threshold that is
  nonetheless a genuine god-class by cohesion, not just by size.

#### A.2.7 Component-level distance metrics (abstractness, instability, coupling factor, distance from main sequence)

- **Analysis level**: mostly cheap — instability and coupling factor are computable directly from the existing
  `DependencyGraph` (fan-in/fan-out counts already exist per-node conceptually); abstractness needs a light
  AST pass to count interfaces/abstract classes vs. concrete ones, still file-level, not class-level.
- **Doctrine fit**: good.
- **Evidence**: **none new.** These are **already the exact reserved discriminants** in `docs/ir-schema.md`
  (`arch.metric`'s `fan-in`/`fan-out`/`instability`, explicitly named as pending their own evidence in the
  promotion log). ArchUnitTS shipping a near-identical vocabulary (instability, coupling factor, distance from
  main sequence — Martin's metrics, the same lineage align's reserved names come from) is **corroborating**
  that the reserved shape is well-designed, but it is not new *demand* evidence — no align-validated repo has
  hit a fan-in/fan-out/instability problem the way kluster hit the LOC problem twice.
- **Recommendation**: **reserve-with-trigger, status quo unchanged.** Note this explicitly in any future
  promotion discussion so the ArchUnitTS parity isn't mistaken for new evidence.

---

## Thread B — security rules (package-poisoning / supply-chain focus)

### B.1 Threat landscape (what the design must defend against)

Current, cited research (fetched during this evaluation):

- **Scale**: Sonatype's 2026 State of the Software Supply Chain report counted **454,600+ new malicious
  open-source packages in 2025**, pushing its cumulative blocked total past **1.23 million** — a 75% YoY
  increase ([sonatype.com](https://www.sonatype.com/state-of-the-software-supply-chain/2026/open-source-malware)).
- **Typosquatting**: single-character transpositions/substitutions (`chal-k` for `chalk`, `lodahs` for
  `lodash`), prefix/suffix additions, scope confusion.
- **Dependency confusion**: a public package published under the same name as an internal/private one, which
  npm can resolve to instead of the intended internal source.
- **Install-script abuse**: the Axios-compromise variant injected obfuscated code into a legitimate package's
  `postinstall` hook — harder to detect than a malicious package body because it runs before any static review
  of the shipped code ([unit42.paloaltonetworks.com](https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/)).
- **Self-propagating worms and maintainer-account compromise**: "Shai-Hulud" added self-propagation across
  the npm ecosystem in 2025; in 2026, North Korea's "Sapphire Sleet" group poisoned 140+ Mastra AI packages in
  19 minutes via compromised maintainer credentials
  ([shattered.io](https://shattered.io/npm-supply-chain-attacks-2026/), [tech-insider.org](https://tech-insider.org/npm-supply-chain-attack-2026/)).
- **Defenses in active use**: `npm audit` (known-CVE matching), Socket.dev (behavioral/heuristic malware
  detection pre-install), `lockfile-lint` (registry-source/URL validation against an allowlist), npm
  provenance via Sigstore (cryptographic build attestation logged to a public transparency ledger,
  GA since npm's Sigstore rollout — [blog.sigstore.dev](https://blog.sigstore.dev/npm-provenance-ga/),
  [docs.npmjs.com](https://docs.npmjs.com/generating-provenance-statements/)), npm trusted publishers (OIDC-based
  publish-time identity, policy tightened as of May 20 2026 —
  [docs.npmjs.com](https://docs.npmjs.com/trusted-publishers/)).

This is real, current, and severe — but it is **landscape evidence, not align-repo evidence**. Every other
rule-kind promotion in this project's history (LOC, the pnpm realpath fix, the workspace-name fallback) was
triggered by a specific, cited finding against a specific real repo align scanned. No security-analog scan has
ever been run. That asymmetry is the central finding of this thread and shapes every recommendation below.

### B.0 `custom.host` registration surface (cross-cutting — evaluated on its own, per explicit request)

- **Current state, verified in code**: `packages/core/src/rules/host-rules.ts` defines `validateHostRules`,
  which throws `UnknownHostRuleError` for any `custom.host` rule whose `hostRuleName` isn't in a
  `ReadonlySet<string>` of registered predicates. `packages/core/src/orchestrator.ts:86` calls it with
  `new Set<string>()` — **always empty**. There is no config-side API (`defineProject`'s `custom` factory was
  never implemented — `IMPLEMENTATION_PLAN.md`'s Stage 2 DSL design names `custom` as a reserved factory key,
  but no implementation exists) to populate that set. `packages/core/src/build/ground.ts:115-128` independently
  refuses to ground any `custom.host` proposal for the same reason — a doc-authored `custom.host` rule is
  rejected at grounding time, not just at check time.
- **What it takes**: a predicate-registration API on the config side (something like
  `defineProject({ hostRules: { thinRouteHandlers: (file, graph) => ... } })`), threaded through to the
  `ReadonlySet<string>` (and the actual predicate functions) that `validateHostRules` and the `custom.host`
  evaluator both currently lack. This is config-plumbing and one new evaluator branch — not a new analysis
  level, not a new IR schema field (the schema already has `hostRuleName`/`portable: false`).
- **What it unlocks**: (1) parity with ArchUnitTS's `adhereTo(customFn)` escape hatch (§A.1); (2) the cheapest
  possible interim path for narrow, host-specific rules that don't yet justify a first-class IR kind — e.g., a
  hand-rolled predicate for route-handler thinness (`RULESET_REPORT.md` §9 item 1) or a one-off external-import
  check (§B.3.1) before/instead of promoting a portable `arch.*` kind for the same need; (3) it closes a
  concrete, already-demonstrated gap rather than a speculative one.
- **Evidence this already exists, unusually strong for this document**: the HIGH-severity finding from the
  live `align_propose_rules` session (`IMPLEMENTATION_PLAN.md` Stage 3 log) — grounding accepted a
  `custom.host` proposal whose predicate matched nothing, producing a vacuous "0 new violations" dry-run; the
  defensive fix (hard-error instead of silent pass) shipped in `064edaf`, but the underlying capability gap
  (there is still nothing to register a predicate *against*) was explicitly left open by that fix. This is not
  hypothetical evidence — it is a documented, dated, already-occurred false-green.
- **Doctrine-fit comparison the coordinator asked for**: "build the registration surface, users hand-write
  predicates" vs. "promote a first-class `arch.external-imports` kind" for the specific case of
  component-scoped external-import policy (§B.3.1):

  | | `custom.host` + registration surface | first-class `arch.external-imports` |
  |---|---|---|
  | Portable IR | No — `portable: false` by schema design, `ts.*`/host rules are flagged non-portable by definition | Yes |
  | Doc-buildable (`align build` tier 1/2) | No — a hand-written predicate can't be extracted from prose or a fenced block the way a structural `arch.*` rule can | Yes, once the tier-2 bullet grammar covers it |
  | `align_explain_rule` / Mermaid support | No — the evaluator has no structural shape to render | Yes, same machinery as `no-cycles`/`layers` |
  | Agent `fixHint` support | No — `FixHint`'s discriminated union has no generic "run this predicate's suggestion" case | Yes, a new `FixHint` variant is cheap the same way `split-file` was for LOC |
  | Cost to ship | Low — one registration API + wiring an already-designed evaluator hook | Low-moderate — new IR variant, new evaluator, new `FixHint`, requires the scanner fix in §B.3.1 |
  | Best use | One-off, host-specific, low-reuse checks that don't generalize across repos | Any check general enough to want portability, provenance, and the fix loop |

  **Conclusion**: the registration surface is worth building regardless of what happens to
  `arch.external-imports`, because it is infrastructure several other reserve items depend on and because its
  evidence already exists. It should not be treated as a *substitute* for promoting general-purpose kinds like
  `arch.external-imports` when the demand is broad enough to want portability — it is the right home for
  narrow, repo-specific predicates only.
- **Recommendation**: **promote-now** (as infrastructure/mechanism, not a new rule kind — the IR shape already
  exists). This is the one item in this document where the evidence bar the project sets for itself is already
  met.

### B.2 What's expressible today or with a small scanner change

**Corrected finding (see top-of-document correction #2)**: **nothing about external-package imports is
expressible today.** `custom.host` (the only mechanism that could reach it) is non-functional per §B.0, and
the scanner discards external edges entirely (`scanner.ts:228-229`). Both paths the original brief assumed
were open are closed. What follows is therefore scoped as new work, correctly, not "already there."

#### B.2.1 `arch.external-imports` — component-scoped external-package allowlist/denylist

- **Concept**: "component X may only import externals from an allowlist" / "no component imports
  `child_process`/`eval`-adjacent builtins except an infra allowlist."
- **Analysis level**: import-graph, and now confirmed **cheap relative to a full new scan domain** — the
  scanner already resolves and classifies every specifier as `internal`/`external`/`unresolved`
  (`resolver.resolveSpecifier`); the only change needed is to stop discarding the `external` case and instead
  push a lightweight edge (`{ from, component, specifier, line }`, no destination file node since none exists)
  into a new `DependencyGraph.externalEdges` (or equivalent) array. This is a small, well-scoped scanner PR,
  not a new manifest-parsing domain.
- **Doctrine fit**: strong — deterministic, portable (a genuine `arch.*` kind candidate), doc-buildable,
  explainable, fix-hintable, exactly the shape `arch.no-dependency` already has (this could arguably be framed
  as `arch.no-dependency` extended with an external-package selector kind rather than a wholly new rule kind —
  worth deciding at design time, not in this evaluation).
- **Evidence**: threat-landscape only (§B.1). **Zero align-repo demand evidence** — neither the kluster nor
  n8n ruleset exercises asked for this; it does not appear anywhere in `RULESET_REPORT.md`'s reserve-promotion
  section (§6), which is otherwise exhaustive about what that exercise's authors wanted and couldn't express.
- **Recommendation**: **reserve-with-trigger.** Trigger: a live `align_propose_rules` session or dogfood need
  naming a concrete external-import boundary — mirroring exactly how LOC's actual promotion trigger was two
  files found in a live exercise, not a synthetic proposal. Given the scanner change is small, this is a
  reasonable candidate for the recommended manifest-security probe (§B.4) to test for cheaply alongside the
  manifest items below.

### B.3 What needs a new scan domain: package.json/lockfile as first-class scan targets

None of this exists today (`packages/plugin-typescript/src/workspace.ts` only ever reads `package.json`'s
`name` field, for workspace-package inventory — confirmed by reading the full file; no `dependencies`,
`devDependencies`, or `scripts` field is ever parsed, and no lockfile is parsed anywhere in the codebase).
Every item below is genuinely new scanner surface.

| Candidate | Deterministic? | Offline-capable? | Assessment |
|---|---|---|---|
| **New-dependency-added gate** (any dep not in the last accepted baseline = red) | Yes — pure manifest diff | Yes — no registry contact needed | Best-fit candidate in this thread: reuses the baseline-consent doctrine (`baseline accept --rule`, ADR 006) with zero new UX concepts, matching the task brief's own framing exactly |
| **Install-script detection** (`postinstall`/`preinstall`/`install` present) | Yes, if scoped to *installed* packages | **Only post-install** — pre-install prediction needs a registry metadata query (a package's `package.json` isn't available before `pnpm install` places it); align's read-only, pre-install-safe posture (ADR 004: "align must not require `pnpm install` before it can see a repo's architecture") is in tension with a pre-install variant | Scope v1 to the offline post-install-scan variant only; treat pre-install prediction as out of scope (see §B.3.1's network-gate discussion) |
| **Non-registry dependency sources forbidden** (`git+`, `http:`, `file:` specifiers in manifest) | Yes — string pattern on manifest | Yes | Cheap, general supply-chain hygiene; low complexity, low false-positive risk |
| **Version-pinning policy** (no `^`/`~` ranges) | Yes | Yes | Cheap but low differentiation — `.npmrc`'s `save-exact=true` plus a CI check already covers most of this need without align; low priority either way |
| **Registry allowlist / resolved-URL validation** | Yes | Yes | **Wrap, don't build** — `lockfile-lint` already validates lockfile package sources against a registry allowlist; no align-specific value-add identified |
| **Workspace-name / dependency-confusion check** (do align's known internal package names collide with anything already claimed on the public npm registry) | The *answer* is a deterministic fact, but obtaining it requires a live query against an external, time-varying data source | **No** — this is the one item that cannot be made offline | See §B.3.1 — this is the concrete example motivating a "network gate class" |

#### B.3.1 The network-gate question (task explicitly asks this be addressed)

Two candidates above (pre-install install-script prediction, and the workspace-name/dependency-confusion
check) cannot be answered from local repo state alone — they require a live registry query. This is a real
tension with align's existing doctrine, not a minor detail:

- **ADR 005** (verification freshness) requires the oracle "never answer from state older than the code it
  judges" — this assumes the *code* is the only thing whose freshness matters. A registry-backed check
  introduces a second freshness axis (is the public registry's current state reflected?) that the existing
  rescan-on-check model has no vocabulary for.
- **ADR 001** already rejected LLM-in-the-loop verification specifically because "a verdict that can't be
  reproduced isn't a verdict" — a registry query is not LLM-non-determinism, but it shares the same failure
  shape: the same repo state can produce a different verdict on two different days (a name gets squatted
  between checks), and a network call can fail, rate-limit, or time out in ways a pure filesystem scan cannot.
- **align already knows the fact base a dependency-confusion check would need on its own side** —
  `workspace.ts`'s `loadWorkspacePackages` already extracts every internal package name at scan time — so the
  gap is purely the network half, not the local half.

**Recommendation**: do not fold either candidate into the deterministic `check` hot path. If built, scope both
as `align doctor`-class advisories — explicitly best-effort, allowed to be stale, allowed to fail open (a
network error produces "could not verify," never a false "clean") — never a blocking gate. This mirrors how
`align doctor` already carries advisories (dead aliases, uncertainty) that are informative rather than
gating. A genuine network-backed *gate* class (if ever wanted for something beyond security) would need its
own ADR; this document flags the need rather than designing it.

### B.4 Wrap-vs-build (ADR 001's doctrine, applied to security)

| Capability | Wrap or build | Reasoning |
|---|---|---|
| Known-CVE matching (`npm audit`) | **Wrap** (later, via `security.tool`) | Requires a maintained, continuously-updated vulnerability database — explicitly not a job align should take on, generalizing ADR 001's precedent of not re-implementing tsc/eslint |
| Behavioral/heuristic malware detection (Socket-class) | **Wrap, or reject even as a wrap** | Statistical/heuristic, not a deterministic oracle — sits uneasily with the false-green-is-severity-zero doctrine; `IMPLEMENTATION_PLAN.md` already explicitly rejected a Python-dependency (semgrep-class) tool in v1 for breaking the pure-Node story, a directly analogous precedent |
| Registry-source/URL allowlisting | **Wrap** | `lockfile-lint` already does this well; no identified align-specific value-add |
| New-dependency-added baseline gate | **Build** | No existing tool ties "new dependency" to align's specific baseline-as-debt consent model; this is exactly the kind of judgment-plus-fix-loop integration align's architecture rules already do for import-graph violations |
| Component-scoped external-import policy | **Build** | No existing tool scopes an import-policy check to align's component graph — `npm audit`/Socket operate at the whole-dependency-tree level, not "which internal component imports which external package" |
| The fix loop itself | **Build (already exists, generically)** | Per `IMPLEMENTATION_PLAN.md`'s stated design, the agent loop is "a generic consumer of `CheckRun`" — any new security gate that emits a `Violation` gets the fix loop for free, which is align's structural differentiator over report-only tools like `npm audit`/Socket regardless of which specific security rules are built |
| Runtime/network behavioral analysis (sandboxed install monitoring, egress detection) | **Explicitly out of scope** | Dynamic analysis is a different tool class from align's static, deterministic scan-and-discard model; no amount of doctrine-fit massaging makes this a natural extension |

### B.5 Recommended staged path

Given the evidence asymmetry (§B.1), the honest staged path front-loads evidence-gathering rather than
promotion:

1. **Stage B-0 (do this first, cheap)**: build the `custom.host` registration surface (§B.0) — evidence
   already exists, low cost, unblocks narrow interim checks.
2. **Stage B-1 (the recommended "first security gate" composition, evidence-gathering, not yet promoted)**: a
   Stage-S-shaped manifest-security probe scoped to the fully-offline, fully-deterministic items only —
   new-dependency-added gate, non-registry-source detection, post-install-only install-script detection, run
   against align's own `package.json`/`pnpm-lock.yaml`, then read-only against kluster's and n8n's. This is
   the same "throwaway spike before committing design" move the project used for architecture, and it is the
   only way to close the evidence gap this document identifies. Expected cheap: these are manifest-diff
   operations on repos align already has read access to.
3. **Stage B-2 (promote only what the probe demonstrates a real hit for)**: whichever of §B.3's table survives
   the probe with a genuine finding (an actual undisclosed install script, an actual non-registry dependency,
   an actual new-dependency drift) gets promoted with that finding cited, exactly like `arch.metric`'s
   promotion log entry.
4. **Explicitly out of scope for any near-term stage**: runtime/network behavioral analysis (§B.4); any
   registry-backed check folded into the blocking `check` gate rather than an `align doctor` advisory (§B.3.1);
   known-CVE matching (wrap `npm audit` later, don't rebuild it).

---

## Consolidated recommendation table

| Rule kind / item | Analysis level | Doctrine fit | Evidence | Recommendation | Trigger |
|---|---|---|---|---|---|
| `arch.naming` | cheap (file/path regex) | good | weak — RULESET §6.3 graded as duplication, not naming | reserve-with-trigger | genuine naming (not duplication) violation demonstrated |
| Component sub-path scoping | cheap (selector composition) | good | real, single-instance — Stage 3 log + RULESET §9.1 | reserve-with-trigger (closest to promote) | second independent hit, or maintainer judgment call |
| Duplication — fuzzy near-duplicate | new domain, probabilistic | conflicts (non-binary verdict) | weak — RULESET §6.3 "weaker evidence" | reject-with-reason | n/a — doctrine conflict, not evidence-gated |
| Duplication — exact structural-clone hash | new domain, deterministic sub-variant | good | weak | reserve-with-trigger | repo showing byte-identical-modulo-whitespace structures |
| Nx-specific rules (project cycles/boundaries/tags) | new manifest format entirely | fine in principle | none — align untested against any Nx repo | reject-with-reason | external validation against a real Nx monorepo |
| UML/PlantUML diagram conformance | N/A (authoring-format alt.) | conflicts (duplicates ADR 011) | none | reject-with-reason | n/a |
| Class-level metrics (LCOM96a/96b) | new domain + new graph granularity | tension w/ file-level model | none | reject-with-reason | a LOC false-negative (small-but-incohesive file) |
| Class-level counts (method/field/statement) | new domain + new graph granularity | tension w/ file-level model | none | reject-with-reason | same as LCOM, or bundled with it |
| Component distance metrics (abstractness/instability/coupling/DMS) | mostly cheap (fan-in/out exist; abstractness = light AST) | good | none new — ArchUnitTS parity corroborates shape only | reserve-with-trigger, unchanged | repo demonstrating a real instability/coupling problem |
| `custom.host` registration surface | N/A (execution plumbing) | good — closes existing schema gap | strong — HIGH finding, `064edaf` | **promote-now** | n/a — evidence already exists |
| Ad hoc per-rule glob/regex matching (bypassing components) | cheap | conflicts by design (ADR 003) | n/a — deliberate divergence | reject-with-reason | n/a |
| Multi-format graph exports / HTML dashboards | N/A (reporting) | out of scope (ADR 007 token economy) | n/a | reject-with-reason | n/a |
| Manifest as first-class scan target | new domain | good | threat-landscape only, no repo-specific | reserve-with-trigger | manifest-security probe (§B.5 Stage B-1) |
| `security` new-dependency-added gate | manifest diff, deterministic, offline | excellent (reuses baseline-consent verbatim) | threat-landscape only | reserve-with-trigger | same probe |
| Install-script detection (post-install only) | manifest/installed-tree scan | good, offline-scoped | threat-landscape (Axios postinstall precedent) | reserve-with-trigger | same probe |
| Non-registry dependency sources forbidden | manifest string pattern, deterministic, offline | good | threat-landscape, general | reserve-with-trigger | same probe |
| Version-pinning policy | manifest string pattern, deterministic, offline | good, low differentiation | weak/general | reserve-with-trigger, low priority | same probe |
| Registry allowlist / resolved-URL validation | manifest+lockfile parse | wrap-not-build | n/a — `lockfile-lint` covers it | reject-with-reason | n/a |
| Workspace-name / dependency-confusion registry check | needs live registry query — new network-gate class | tension w/ ADR 001/005 freshness doctrine | strong conceptual fit, but network-blocked | reserve-with-trigger, `doctor`-advisory only | its own ADR deciding the network-gate class |
| `arch.external-imports` (component-scoped external allowlist) | cheap now (small scanner change, not new domain) | strong | threat-landscape only, zero align-repo demand | reserve-with-trigger | a live `align_propose_rules` session or dogfood need naming a concrete boundary |
| `npm audit`-class CVE matching | N/A | wrap-not-build | n/a | reject-with-reason | n/a |
| Socket-class behavioral/ML malware detection | N/A | conflicts (non-deterministic) + Python precedent already rejected | n/a | reject-with-reason | n/a |
| Runtime/network behavioral analysis | N/A — different tool class entirely | conflicts fundamentally | n/a | reject-with-reason | explicitly out of scope, no trigger contemplated |
