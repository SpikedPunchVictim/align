# `@spikedpunch/align-core` — Interface Signatures

This document specifies the full TypeScript surface of `@spikedpunch/align-core` for v1 (ADR 001/008 scope: `parse`,
`architecture`, and — as of ADR 013 — `security` gates), plus two contracts that activate at later stages
(`ValidatedEdit`/`FixProposal`, ADR 010) but must be anticipated now because the `Violation` model has to
carry the data they need. Follows
`CODING_BEST_PRACTICES.md` §9–13: discriminated unions over optional-soup, `readonly` by default, branded
types where confusion is expensive, parse-don't-validate at every boundary (zod, ADR 002).

## Branded primitives

```ts
// Confusion between these is expensive (wrong file targeted, wrong rule cited, baseline entry
// applied to the wrong violation) — brand them per CODING_BEST_PRACTICES.md §11.
type RepoRelativePath = string & { readonly __brand: 'RepoRelativePath' };
type ComponentName = string & { readonly __brand: 'ComponentName' };
type RuleId = string & { readonly __brand: 'RuleId' };
type ViolationId = string & { readonly __brand: 'ViolationId' }; // snippet-hash fingerprint, ADR 006

// Constructors live at the trusted boundary (scanner output, DSL component registration, zod .parse());
// everywhere else these are trusted, not re-validated.
function toRepoRelativePath(raw: string): RepoRelativePath;
function toComponentName(raw: string): ComponentName;
```

## Violation model

```ts
type Category = 'architecture' | 'security' | 'types' | 'lint' | 'format';
// v1 populates 'architecture' only; the union is fixed now so ADR 007/008's priority ordering
// and GateResult shape don't change when later gates add categories.

type Severity = 'error' | 'warning' | 'info';

interface SourceRange {
  readonly startLine: number;
  readonly endLine: number;
}

interface CycleEdge {
  readonly from: RepoRelativePath;
  readonly to: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
}

// Short-code form, not prose — ADR 007: fixHint is structured, message text is rendered at the surface.
type FixHint =
  | { readonly code: 'remove-import'; readonly file: RepoRelativePath; readonly line: number }
  | { readonly code: 'relocate-shared-code'; readonly from: ComponentName; readonly to: ComponentName }
  | { readonly code: 'invert-dependency'; readonly owner: ComponentName }
  | { readonly code: 'break-cycle-edge'; readonly suggestedEdge: CycleEdge }
  | { readonly code: 'manual-review' }
  // 'split-file' un-reserved 2026-07-12 — arch.metric (max-LOC) promotion, IMPLEMENTATION_PLAN.md's
  // Promotion log.
  | { readonly code: 'split-file'; readonly file: RepoRelativePath };
  // Reserved fix-hint codes arrive with their rule kinds (reserve, docs/ir-schema.md):
  // 'rename-to-match-pattern' (arch.naming) · 'reduce-fan-in' / 'reduce-fan-out' (arch.metric's
  // fan-in/fan-out metrics — still reserved pending their own evidence)

interface ViolationBase {
  readonly id: ViolationId;          // snippet-hash fingerprint (ADR 006) — stable under unrelated edits
  readonly ruleId: RuleId;
  readonly category: Category;
  readonly severity: Severity;
  readonly file: RepoRelativePath;
  readonly range: SourceRange;
  readonly snippet: string;          // exact source text at range — required, not optional (ADR 007/010:
                                      // dedup and future edit-block construction both depend on this)
  readonly fixHint: FixHint;
  readonly because?: string;         // hoisted .because() / sourceQuote (ADR 002/011)
}

// Discriminated union, not optional-soup (CODING_BEST_PRACTICES.md §10) — each rule kind's structural
// fields are only present on its own variant; there is no `data?: X` that could be forgotten.
type Violation =
  | (ViolationBase & {
      readonly kind: 'no-dependency';
      readonly fromFile: RepoRelativePath;
      readonly toFile: RepoRelativePath;
      readonly fromComponent: ComponentName;
      readonly toComponent: ComponentName;
      readonly specifier: string;
      readonly line: number;
    })
  | (ViolationBase & {
      readonly kind: 'no-cycles';
      readonly chain: readonly CycleEdge[];        // per-edge detail, not just file names (ADR 004, spike Q4)
      readonly suggestedBreakEdge: CycleEdge;
    })
  | (ViolationBase & {
      readonly kind: 'layers';
      readonly fromLayer: ComponentName;
      readonly toLayer: ComponentName;
      readonly fromFile: RepoRelativePath;
      readonly toFile: RepoRelativePath;
      readonly specifier: string;
      readonly line: number;
    })
  // 'metric' un-reserved 2026-07-12 — arch.metric (max-LOC) promotion, IMPLEMENTATION_PLAN.md's
  // Promotion log. `metric` is a literal today (`'loc'` only); grows to a union alongside
  // RuleIR's `arch.metric.metric` when fan-in/fan-out/instability are promoted.
  | (ViolationBase & {
      readonly kind: 'metric';
      readonly metric: 'loc';
      readonly component: ComponentName;
      readonly value: number;
      readonly threshold: number;
    })
  // 'custom' — custom.host registration surface (§B.0, promoted 2026-07-12, ADR 002 amendment).
  // `detail` is the registered predicate's own `HostViolation.message`; `fixHint` is always
  // `{ code: 'manual-review' }` (no structural fix align itself can propose for host-defined logic).
  | (ViolationBase & {
      readonly kind: 'custom';
      readonly hostRuleName: string;
      readonly detail: string;
    })
  // 'manifest-source-hygiene' / 'manifest-new-dependency' — security.manifest.* (ADR 013, promoted
  // 2026-07-12 on spike/MANIFEST_PROBE_REPORT.md probe evidence). `file` (ViolationBase) is the
  // declaring package.json; `depName`/`specifier` are structured fields, never folded into prose
  // (ADR 007). `fixHint` is always `{ code: 'manual-review' }` — no structural fix align can
  // propose for a manifest-level finding.
  | (ViolationBase & {
      readonly kind: 'manifest-source-hygiene';
      readonly depName: string;
      readonly specifier: string;                    // lockfile-resolved when available
      readonly sourceType: 'git' | 'http' | 'file' | 'link';
    })
  | (ViolationBase & {
      readonly kind: 'manifest-new-dependency';
      readonly depName: string;
      readonly specifier: string;
      readonly depField: 'dependencies' | 'devDependencies'; // name-level, runtime+dev only
    });
  // Reserved variant (arrives with its rule kind — reserve pending evidence, docs/ir-schema.md):
  // 'naming' { actual, pattern }

// A rendering function, not a stored field — ADR 007. Lives at the CLI/MCP surface layer.
declare function renderViolationMessage(v: Violation): string;
```

## Ruleset IR

```ts
type FileSelector =
  | { readonly kind: 'glob'; readonly patterns: readonly string[] }
  | { readonly kind: 'package'; readonly packageNames: readonly string[] };

// Greenfield mode (ADR 003 amendment): 3-state empty-selector policy, replacing the boolean
// `allowEmpty`. 'fail' (default) is unchanged ADR 003 safety; 'allow' is the old allowEmpty:true
// behavior; 'until-populated' additionally self-heals (auto-arms) once the component has real
// files. Both non-'fail' policies surface as `ungrounded-component` entries in
// `CheckRun.ungroundedComponents` (ADR 008 amendment) instead of silently. The DSL's
// `allowEmpty: true` (dsl/index.ts's `ComponentDeclaration`) is a deprecated alias for
// `empty: 'allow'` — kept working unchanged for back-compat.
type EmptyPolicy = 'fail' | 'allow' | 'until-populated';

interface ComponentDefinitionIR {
  readonly name: ComponentName;
  readonly selector: FileSelector;
  readonly empty: EmptyPolicy;
}

// R1 (greenfield mode): a component that's green only because it currently matches zero files
// (empty: 'allow' | 'until-populated'). `findUngroundedComponents` (components/registry.ts)
// computes this from the same classified-components set the reference-validity guard step
// already built; `GateOrchestrator.check` threads the result onto `CheckRun.ungroundedComponents`.
interface UngroundedComponent {
  readonly name: ComponentName;
  readonly selector: string;         // human-readable selector description, e.g. 'src/api/**'
  readonly policy: 'allow' | 'until-populated';
}

type ComponentRef = ComponentName;   // rules reference components by name, never raw globs (ADR 003)

interface RuleProvenance {
  readonly because?: string;
  readonly sourceFile?: RepoRelativePath;      // set only for align-build-generated rules (ADR 011)
  readonly sourceLineRange?: SourceRange;
  readonly sourceQuote?: string;
}

type RuleIR =
  | {
      readonly kind: 'arch.no-dependency'; readonly id: RuleId;
      readonly from: ComponentRef; readonly to: ComponentRef;
      readonly provenance: RuleProvenance;
    }
  | {
      readonly kind: 'arch.no-cycles'; readonly id: RuleId;
      readonly scope: 'repo' | ComponentRef;
      readonly includeTypeOnly: boolean;         // default false (ADR 004, probe 5a)
      readonly provenance: RuleProvenance;
    }
  | {
      readonly kind: 'arch.layers'; readonly id: RuleId;
      readonly layers: readonly { readonly layer: ComponentRef; readonly canDependOn: readonly ComponentRef[] }[];
      readonly provenance: RuleProvenance;
    }
  | {
      readonly kind: 'custom.host'; readonly id: RuleId;
      readonly hostRuleName: string; readonly portable: false;
      readonly provenance: RuleProvenance;
    }
  | {
      // Promoted 2026-07-12 (user-approved, kluster ruleset evidence — IMPLEMENTATION_PLAN.md's
      // Promotion log). `metric` is a growable literal: `'loc'` only today, a union when
      // fan-in/fan-out/instability graduate (still reserved, see below).
      readonly kind: 'arch.metric'; readonly id: RuleId;
      readonly target: ComponentRef; readonly metric: 'loc'; readonly max: number;
      readonly provenance: RuleProvenance;
    }
  | {
      // Promoted 2026-07-12 (user-approved, spike/MANIFEST_PROBE_REPORT.md probe evidence, ADR
      // 013). No ComponentRef at all — repo-wide, the manifest scan domain has no notion of
      // align's file-classified components.
      readonly kind: 'security.manifest.source-hygiene'; readonly id: RuleId;
      readonly provenance: RuleProvenance;
    }
  | {
      // Promoted 2026-07-12 (user-approved, ADR 013). Also no ComponentRef.
      readonly kind: 'security.manifest.new-dependency'; readonly id: RuleId;
      readonly provenance: RuleProvenance;
    };
  // Reserved discriminants (name only, not implemented in v1 — docs/ir-schema.md):
  // 'arch.naming' (demoted at sign-off review — not spike-exercised)
  // 'lint.tool' | 'format.tool' | 'types.tool' | 'tests.tool' | 'security.secrets' | 'security.tool' | 'ts.*'
  // arch.metric's fan-in / fan-out / instability metrics (loc was promoted; these still need evidence)
  // security.manifest's install-script-exposure sibling (spike/MANIFEST_PROBE_REPORT.md Rule 2 —
  // held back pending a content-pattern classifier rework, see ADR 013's follow-up ladder)

interface RulesetIR {
  readonly irVersion: '1';
  readonly components: Readonly<Record<ComponentName, ComponentDefinitionIR>>;
  readonly rules: readonly RuleIR[];
}

// Parse, don't validate (CODING_BEST_PRACTICES.md §12) — the zod schema IS the type; RulesetIR above
// is z.infer<typeof RulesetIRSchema>. Every RulesetIR in the system passed through .parse() once, at
// the DSL→IR boundary or the align-build boundary; nothing downstream re-validates it.
```

## Dependency graph

```ts
type EdgeKind = 'import' | 'reexport' | 'dynamic' | 'type-only';

interface DependencyGraphNode {
  readonly file: RepoRelativePath;
  readonly component: ComponentName;
  readonly loc: number;
  readonly exports: readonly string[];
}

interface DependencyGraphEdge {
  readonly from: RepoRelativePath;
  readonly to: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
  readonly kind: EdgeKind;           // type-only is first-class, 32% of edges measured (ADR 004)
}

type UncertaintyReason =
  | 'non-literal-dynamic-specifier'  // spike: 1 in 456K LOC, 15 in 3.23M LOC
  | 'unresolvable-specifier'
  | 'asset-specifier'                // .css/.svg/.vue/.json-ish — not graph uncertainty (ADR 004)
  | 'build-output-excluded'          // configurable excludes, e.g. .stage/, dist-bundle/
  | 'fixture-excluded';              // human consent decision, not a layout heuristic (ADR 003)

interface UncertaintyMarker {
  readonly file: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
  readonly reason: UncertaintyReason;
}

interface DependencyGraph {
  readonly nodes: readonly DependencyGraphNode[];
  readonly edges: readonly DependencyGraphEdge[];
  // External-package retention (Stage 5 infra, ADR 004 amendment below). Deliberately separate
  // arrays, not merged into nodes/edges above — every `arch.*` evaluator only ever reads
  // nodes/edges (file-to-file), so component classification/cycles/layers/metrics are unaffected
  // by construction (verified: rule counts on kluster/n8n identical before/after this change).
  // `custom.host` predicates see these via `ctx.graph.externalNodes`/`externalEdges`.
  readonly externalNodes: readonly ExternalPackageNode[];
  readonly externalEdges: readonly ExternalDependencyEdge[];
  readonly uncertain: readonly UncertaintyMarker[];
  readonly scannedAt: number;        // epoch ms — the freshness proof underlying ADR 005
}

// Name-level (not per-import-site) — one node per distinct external package, dedupe'd across the
// whole scan. `id` doubles as a stable Map key and as `ExternalDependencyEdge.to`.
interface ExternalPackageNode {
  readonly id: string;               // 'external:node:child_process' | 'external:lodash'
  readonly packageName: string;      // 'child_process' | 'lodash' | '@scope/pkg'
  readonly isBuiltin: boolean;       // Node builtin vs. npm package
}

interface ExternalDependencyEdge {
  readonly from: RepoRelativePath;
  readonly to: string;               // ExternalPackageNode.id
  readonly specifier: string;        // exact source specifier, e.g. 'node:child_process'
  readonly line: number;
  readonly kind: EdgeKind;           // preserved exactly like internal edges
}
```

**Memory note (measured, n8n read-only)**: externals are the majority of import specifiers in a
real repo, and the same package name repeats across thousands of import sites — the scanner interns
`ExternalPackageNode.id`/`packageName`/edge `specifier` strings per-scan (a `Map<string,string>`
reused across every file), so retained memory scales with distinct-package count, not edge count.
n8n (17,959 files after adding .mjs/.cjs/.mts/.cts below) retains 3,742 external edges pointing at
only 41 distinct external nodes — peak RSS and wall time were flat within run-to-run noise before
vs. after (see the Stage 5 report for exact numbers), not a regression.

## Scanner contract

```ts
interface ScanInput {
  readonly rootDir: RepoRelativePath;
  readonly components: Readonly<Record<ComponentName, ComponentDefinitionIR>>;
  readonly excludes: readonly string[];   // configurable build-output excludes (ADR 004)
}

interface Scanner {
  // Always a fresh, full scan in v1 — no partial/incremental mode exists to call by mistake (ADR 005).
  scan(input: ScanInput): Promise<DependencyGraph>;
}
```

## Rule evaluator

```ts
// Pure function: (rule, graph, components) -> violations. No I/O, no mutation, fully testable with
// plain data (CODING_BEST_PRACTICES.md §14). One evaluator per RuleIR kind; the orchestrator dispatches
// by `kind` through an exhaustive switch (never-check) so a new IR kind that's missing an evaluator is a
// compile error, not a silent no-op.
type RuleEvaluator<TRule extends RuleIR = RuleIR> = (
  rule: TRule,
  graph: DependencyGraph,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
) => readonly Violation[];
```

## Manifest scan domain (ADR 013)

A disjoint scan domain from `DependencyGraph`/`Scanner` above — package.json/pnpm-lock.yaml text,
not parsed TypeScript. `@spikedpunch/align-core` defines only the shape and the injection seam; the concrete
pnpm/Node-ecosystem reader (`NodeManifestScanner`) lives in `@spikedpunch/align-plugin-typescript` (ADR 013's
placement decision — core stays language/ecosystem-agnostic per ADR 001/004's boundary), wired in at
the CLI composition root exactly like `LanguagePlugin`/`TypeScriptPlugin`.

```ts
type ManifestDepField = 'dependencies' | 'devDependencies' | 'optionalDependencies';

interface ManifestDependency {
  readonly name: string;
  readonly specifier: string;        // lockfile-resolved when a pnpm-lock.yaml is present
  readonly field: ManifestDepField;
  readonly line?: number;            // best-effort raw-text line, for Violation.range/snippet
}

interface ManifestRecord {
  readonly file: RepoRelativePath;   // repo-relative package.json path (root or workspace member)
  readonly raw: string;              // exact source text — the Violation.snippet extraction source
  readonly dependencies: readonly ManifestDependency[];
}

interface ManifestInventory {
  readonly manifests: readonly ManifestRecord[];
  readonly lockfilePresent: boolean;
}

interface ManifestScanOptions {
  readonly rootDir: string;
  readonly excludes: readonly string[];
}

interface ManifestScanner {
  scan(options: ManifestScanOptions): Promise<ManifestInventory> | ManifestInventory;
}

// Pure dispatcher over the disjoint SecurityManifestRule union (security.manifest.* only) — the
// sibling of the graph-based RuleEvaluator above. GateOrchestrator's `security` gate is the only
// real caller; `ruleCategoryOf(rule: RuleIR): Category` partitions RulesetIR.rules between this
// and the graph-based evaluateRule before either ever runs.
type SecurityManifestRule = Extract<RuleIR, { kind: `security.manifest.${string}` }>;
function evaluateManifestRule(rule: SecurityManifestRule, inventory: ManifestInventory): readonly Violation[];
```

**Fingerprint discipline (ADR 006/013)**: both `security.manifest.*` evaluators key their
`Violation.id` on `(declaring manifest path, dependency name)` only — never the specifier value or
a line number — so a git-ref bump, a version bump, or a manifest reformatting never resets baseline
consent for an already-reviewed/already-accepted dependency. This is the same "line numbers break
under reformatting" doctrine `baseline/fingerprint.ts` documents for every other rule kind, applied
to the one new axis manifest rules introduce (specifier-value churn).

**`evaluateRule` (the graph-based dispatcher above) returns `[]` for both `security.manifest.*`
kinds**, by design — they are real `RuleIR` members (so DSL/tier-2/`align build` can author and
round-trip them like any other kind) but have no `DependencyGraph`-shaped evaluation; only
`evaluateManifestRule` against real `ManifestInventory` data produces their actual violations.
Known consequence: `align build`/`align explain`'s generic graph-based impact-delta preview
under-reports manifest-rule violations (always 0) — `align check`'s `security` gate remains the
authoritative evaluation path. Threading `ManifestInventory` through those preview call sites is a
documented follow-up (ADR 013), not built in this promotion.

## Host predicate registration surface (custom.host, §B.0, ADR 002 amendment)

`custom.host`'s evaluator (`evaluateCustomHost`) is the one `RuleEvaluator` that also takes an
injected, host-side registry — a fourth parameter the other kinds ignore — but stays just as pure
and I/O-free as every other evaluator: predicates read the already-scanned graph, they never touch
the filesystem/network/clock themselves.

```ts
// Narrow, typed predicate input — pure data in, HostViolation[] out.
interface HostRuleContext {
  readonly graph: DependencyGraph;
  readonly componentOf: (file: RepoRelativePath) => ComponentName | undefined;
  readonly files: readonly RepoRelativePath[];
}

// Minimal predicate output — core (never the predicate) fingerprints, defaults fixHint to
// 'manual-review', and hoists the rule's .because(). range/snippet default to line 1 / the
// scanned node's first-line snippet when omitted.
interface HostViolation {
  readonly file: RepoRelativePath;
  readonly range?: SourceRange;
  readonly snippet?: string;
  readonly message: string;
}

type HostPredicate = (ctx: HostRuleContext) => readonly HostViolation[];
type HostPredicateRegistry = ReadonlyMap<string, HostPredicate>;

// Authored in align.config.ts's sibling `hostRules` export (never passed through `defineProject`
// itself — RulesetIR is portable JSON, ADR 002, and functions can't survive that boundary), keyed
// by the name a `c.custom.host(name)` rule references. The CLI composition root extracts this map
// from the loaded config and injects it into `GateOrchestrator`; core never constructs one itself.

function evaluateCustomHost(
  rule: CustomHostRule,
  graph: DependencyGraph,
  predicates: HostPredicateRegistry,
): readonly Violation[];
// Throws UnknownHostRuleError if `rule.hostRuleName` isn't in `predicates` (defense in depth —
// the orchestrator's `validateHostRules` guard step should already have caught this) and
// HostPredicateExecutionError if the predicate itself throws — never a silent pass, never an
// unattributed crash (ADR 008 amendment, "the reference-validity invariant"'s sibling).
```

## Security: untrusted-mode surface (ADR 014)

`align check --untrusted` never dynamically imports `align.config.ts` and never invokes a `hostRules`
predicate — it is the mitigation for the fact that trusted-mode `align check` is, structurally, code
execution against repo-controlled input (`loadConfig`'s `import()`, and every `custom.host` predicate above).
Two small, pure, core-owned pieces make the untrusted CLI surface possible without touching
`GateOrchestrator`'s evaluation logic at all — it already only ever consumed a `RulesetIR` value, never a
config path:

```ts
// packages/core/src/build/schema.ts + build/export-ir.ts — the untrusted-mode data source. `ruleset` is
// exactly RulesetIR (above) — no new/relaxed fields, no function-valued members, `hostRules` never
// included (predicates can't survive a JSON boundary and are unconditionally unavailable under
// --untrusted regardless — see assertNoCustomHostRules below).
interface ExportedRuleset {
  readonly irVersion: '1';
  readonly exportedAt: number;
  readonly excludes: readonly string[];
  readonly ruleset: RulesetIR;
}
function buildExportedRuleset(
  ruleset: RulesetIR,
  excludes: readonly string[],
  exportedAt?: number,           // defaults to Date.now()
): ExportedRuleset;               // pure, no I/O — the CLI's `export-ir` command does the fs write

// packages/core/src/rules/host-rules.ts — --untrusted's pre-flight guard, called by the CLI before
// GateOrchestrator is even constructed. A ruleset containing custom.host rules is refused outright,
// never silently skipped (ADR 008 amendment's false-green doctrine, same shape as
// UnknownHostRuleError/HostPredicateExecutionError above) — distinct error type/message because this
// isn't a fixable registration bug: align.config.ts's hostRules export is never read under
// --untrusted at all, so there is nothing to register a predicate against.
class UntrustedCustomHostRuleError extends Error {
  readonly ruleIds: readonly string[];
}
function assertNoCustomHostRules(rules: readonly RuleIR[]): void; // throws UntrustedCustomHostRuleError
```

The CLI composition root (`packages/cli/src/commands/check.ts`'s `runUntrustedCheck`, `align-dir.ts`'s
`readRulesetIr`/`writeRulesetIr`) reads/writes the `.align/ruleset-ir.json` artifact and wires the resulting
`RulesetIR` into `GateOrchestrator` with an empty `HostPredicateRegistry` — safe unconditionally, since
`assertNoCustomHostRules` already refused any ruleset that would have needed a non-empty one. Core never
touches the filesystem or the config-loading mechanism itself; see ADR 014 and `docs/ir-schema.md`'s
"`.align/ruleset-ir.json`" section for the full artifact shape and refuse-don't-fallback contract.

## Gate model

```ts
type GateStatus = 'green' | 'red' | 'error' | 'skipped';

interface GateResult {
  readonly gate: 'parse' | Category;
  readonly status: GateStatus;
  readonly violations: readonly Violation[];   // only if 'red' — new, post-baseline
  readonly baselinedCount: number;             // tolerated debt — a count, never payloads (ADR 007)
  readonly passCount?: number;
  readonly errorMessage?: string;              // only if 'error' — environmental, never LLM-facing
  readonly durationMs: number;
  readonly cacheHits: number;                  // always 0 in v1 (ADR 005); field exists for the growth path
  readonly dependsOn: readonly GateResult['gate'][];  // declared metadata, not hardcoded order (ADR 008)
}

interface Advisory {
  readonly kind: string;             // e.g. 'config-conflict' | 'doc-drift' | 'divergence' | 'flaky'
  readonly message: string;
  readonly ruleIds?: readonly RuleId[];
}

interface CheckRun {
  readonly verdict: 'green' | 'red' | 'error';
  readonly gates: readonly GateResult[];
  readonly advisories: readonly Advisory[];    // included even when verdict is green
  readonly scannedAt: number;
  // R1 (greenfield mode): every component that's green only because it matched zero files this
  // scan — surfaced here (not just `align explain`/`doctor`) so a check-agent's own loop sees
  // "green because compliant" and "green because empty" as distinguishable states. Always []
  // when the architecture gate didn't fully evaluate (parse/guard-step error).
  readonly ungroundedComponents: readonly UngroundedComponent[];
}
```

**`security` gate (promoted 2026-07-12, ADR 013)**: `CheckRun.gates` now has three entries in
practice (`parse`, `architecture`, `security`) — the security gate is `dependsOn: []` (ADR 008's
always-run carve-out, same as `format`/`lint`/`security.secrets` in the design doc), computed
independently of and before the TypeScript source scan, so a `parse` failure never masks it and it
never masks `parse`/`architecture`. `GateOrchestrator`'s constructor takes a fifth, optional
argument — `manifestScanner: ManifestScanner = <no-op returning an empty inventory>` — mirroring
the `hostPredicates` injection seam above; the CLI composition root always supplies
`@spikedpunch/align-plugin-typescript`'s `NodeManifestScanner`.

## Baseline store

```ts
interface BaselineEntry {
  readonly fingerprint: ViolationId;           // snippet-hash, not line-based (ADR 006)
  readonly ruleId: RuleId;                     // queryable — enables `baseline accept --rule` (ADR 006)
  readonly file: RepoRelativePath;
  readonly acceptedAt: number;
  readonly acceptedBy: 'init-seed' | 'accept-existing' | 'manual';
}

interface PruneResult {
  readonly removed: readonly ViolationId[];    // no longer present in the graph — fixed
  readonly moved: readonly { readonly from: ViolationId; readonly to: ViolationId }[]; // same
                                                 // snippet hash, different file/line
}

interface BaselineStore {
  isBaselined(violationId: ViolationId): boolean;
  accept(violations: readonly Violation[], mode: BaselineEntry['acceptedBy']): void;
  acceptByRule(ruleId: RuleId): void;
  prune(currentGraph: DependencyGraph): PruneResult;
  show(filter?: { readonly ruleId?: RuleId }): readonly BaselineEntry[];
}
```

## Plugin registry (v1: one language)

```ts
interface LanguagePlugin {
  readonly id: string;                          // 'typescript' in v1
  readonly fileMatch: readonly string[];         // glob patterns claiming files
  readonly scanner: Scanner;
}

interface PluginRegistry {
  getPluginForFile(file: RepoRelativePath): LanguagePlugin | undefined;
  getAllPlugins(): readonly LanguagePlugin[];
}

// v1's registry implementation is a one-element static list — no cross-plugin file-match conflict
// resolution, no priority ordering, no merged-graph logic across plugins. Those are real problems only
// a second LanguagePlugin creates; the interface is written generically so adding one is additive at the
// CLI composition root (ARCHITECTURE.md §5), not an interface rewrite. Future split point: when a second
// language plugin starts, plugin contract + registry extract to `@spikedpunch/align-plugin-api`
// (`IMPLEMENTATION_PLAN.md`, Stage 5) — this interface is written to survive that extraction unchanged.
class StaticPluginRegistry implements PluginRegistry {
  constructor(private readonly plugins: readonly LanguagePlugin[]) {}
  getPluginForFile(file: RepoRelativePath): LanguagePlugin | undefined { /* first fileMatch wins */ }
  getAllPlugins(): readonly LanguagePlugin[] { return this.plugins; }
}
```

## MCP payload shapes (structured-only, ADR 007)

```ts
interface McpCheckPayload {
  readonly verdict: 'green' | 'red' | 'error';
  readonly gates: readonly {
    readonly gate: 'parse' | Category;
    readonly status: GateStatus;
    readonly violationCount: number;
    readonly baselinedCount: number;
    readonly passCount?: number;
  }[];
  readonly violations: readonly Violation[];     // priority-sorted, capped, paginated — failures only
  readonly pagination?: { readonly cursor: string; readonly hasMore: boolean };
  readonly advisories: readonly Advisory[];
}

interface McpExplainRulePayload {
  readonly ruleId: RuleId;
  readonly kind: RuleIR['kind'];
  readonly because?: string;
  readonly components: readonly { readonly name: ComponentName; readonly exampleFiles: readonly RepoRelativePath[] }[];
  readonly mermaid?: string;                     // cycle/dependency-path diagram, arch kinds only
}
```

## Edit-block apply pipeline — activates at the agent stage (Stage 4, ADR 010)

```ts
// Specified now because Violation.snippet/range above must anticipate exactly this consumer.
// Not implemented, not wired into the orchestrator, until Stage 4.

interface EditBlock {
  readonly search: string;
  readonly replace: string;
  readonly nearLine?: number;
  readonly forViolations?: readonly ViolationId[];
}

interface FixProposal {
  readonly files: readonly { readonly path: RepoRelativePath; readonly edits: readonly EditBlock[] }[];
  readonly suppressions?: readonly { readonly ruleId: RuleId; readonly file: RepoRelativePath; readonly line: number }[];
  readonly rationale: string;
}

interface ValidatedEdit {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly replacement: string;
}

interface FailureContext {
  readonly file: RepoRelativePath;
  readonly reason: 'zero-matches' | 'ambiguous-matches' | 'overlapping-spans';
  readonly nearestCandidate?: { readonly linesWithContext: string; readonly startLine: number };
}
```

## Telemetry (local-only, opt-in, ADR 015)

```ts
// packages/core/src/telemetry/types.ts — pure types only, no fs/Date.now()/network primitive
// anywhere in this module (asserted by a dedicated network-abstinence test).

type TelemetrySchemaVersion = 1;

interface TelemetryEnvelope<E extends TelemetryEvent = TelemetryEvent> {
  readonly schemaVersion: TelemetrySchemaVersion;
  readonly sessionId: string;         // one per CLI process, injected — never crypto.randomUUID() in core
  readonly alignVersion: string;
  readonly rulesetIrHash?: string;    // sha256Hex(JSON.stringify(ruleset)) — same hash fn as rules.lock.json
  readonly ts: number;                // injected — never Date.now() in core
  readonly command: string;           // e.g. 'check', 'baseline accept', 'agent run'
  readonly event: E;
}

type CheckScope = 'all' | 'changed' | 'files';   // v1 only ever emits 'all' (ADR 005: full scan, no scoping yet)

interface GateSummary {
  readonly gate: GateKind;
  readonly status: GateStatus;
  readonly newCount: number;          // GateResult.violations.length — new, post-baseline
  readonly baselinedCount: number;
  readonly passCount: number;
}

type TelemetryEvent =
  | { readonly kind: 'check'; readonly verdict: CheckRun['verdict']; readonly gates: readonly GateSummary[];
      readonly wallMs: number; readonly scope: CheckScope; readonly ungroundedComponentCount: number;
      readonly advisoryCounts: readonly { readonly kind: string; readonly count: number }[] }
  | { readonly kind: 'violation-appeared' | 'violation-resolved'; readonly ruleId: string;
      readonly component?: string; readonly file: string; readonly violationFingerprint: string }
  | { readonly kind: 'baseline'; readonly action: 'accept' | 'prune'; readonly ruleScope?: string;
      readonly counts: { readonly accepted?: number; readonly removed?: number; readonly moved?: number } }
  | { readonly kind: 'build'; readonly doc: string; readonly structuralChanges: number;
      readonly provenanceOnlyChanges: number;
      readonly impactDelta: { readonly newViolations: number; readonly maskedBaselined: number } }
  | { readonly kind: 'error'; readonly errorKind: 'gate-error' | 'exception' | 'untrusted-refusal' |
      'unknown-host-rule' | 'ungrounded-fail' | 'unknown'; readonly message: string; readonly command: string }
  | { readonly kind: 'agent'; readonly attempts: number; readonly converged: boolean; readonly iterations: number;
      readonly escalated: boolean; readonly escalationReason?: string;
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } };

// packages/core/src/telemetry/serialize.ts — pure event -> single JSON-line string
function serializeTelemetryEvent(envelope: TelemetryEnvelope): string;

// packages/core/src/telemetry/diff.ts — pure violation-fingerprint diff (drives appear/resolve events)
interface TelemetryStateEntry {
  readonly fingerprint: string;       // Violation.id (ADR 006: snippet-hash, stable under unrelated edits)
  readonly ruleId: string;
  readonly file: string;
  readonly component?: string;
}
interface TelemetryState { readonly violations: readonly TelemetryStateEntry[]; }
function componentOfViolation(v: Violation): string | undefined;
function telemetryStateEntryOf(v: Violation): TelemetryStateEntry;
function diffViolationState(
  previous: readonly TelemetryStateEntry[],
  current: readonly TelemetryStateEntry[],
): { readonly appeared: readonly TelemetryStateEntry[]; readonly resolved: readonly TelemetryStateEntry[] };
```

The CLI (`packages/cli/src/telemetry/`) owns every side effect: `resolveTelemetryPreConfig`/
`resolveTelemetryEnabled` implement the enable precedence (`--telemetry`/`--no-telemetry` >
`ALIGN_TELEMETRY=1` > `align.config.ts`'s `telemetry` export > off), `TelemetryRecorder` is the one
class that builds an envelope and appends a line to `.align/telemetry.jsonl`
(`align-dir.ts`'s `appendTelemetryLine`), and `readTelemetryState`/`writeTelemetryState`
(`align-dir.ts`) persist `TelemetryState` to `.align/telemetry-state.json` — a missing OR corrupt
state file is treated identically as empty (deliberately looser than `readGeneratedRules`'/
`readRulesetIr`'s "corrupted is never absent" discipline: this is a self-healing best-effort cache,
not a portable ruleset artifact whose silent loss would under-enforce a rule). See ADR 015 for the
full design and `docs/adr/015-telemetry.md`'s Decision section for the network-abstinence guarantee.

## Notes on what is deliberately absent from this document

- No `CacheStore` interface — v1 has no cache (ADR 005); `GateResult.cacheHits` exists as a stub field, not
  a live subsystem.
- No `ConflictStore`/learned-conflict interfaces — ADR 012 fixes precedence doctrine only; the store itself
  is Design Reserve.
- No format/lint/types/security/tests adapter interfaces — ADR 001/008 scope; those arrive with their stage.
