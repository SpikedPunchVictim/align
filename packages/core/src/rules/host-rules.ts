import type { ComponentName, RepoRelativePath } from '../types/branded.js';
import { toRuleId } from '../types/branded.js';
import type { CustomHostRule, RuleIR } from '../types/ir.js';
import type { DependencyGraph } from '../types/graph.js';
import type { SourceRange, Violation } from '../types/violation.js';
import { computeFingerprint } from '../baseline/fingerprint.js';

/** Thrown when a `custom.host` rule names a host predicate that is not registered — the third
 * member of the vacuous-green family (`rules/component-refs.ts`, `components/registry.ts`'s
 * `validateClassifiedComponents`): pre-registration, `evaluateRule` returned zero violations for
 * every `custom.host` rule unconditionally, so an unevaluatable rule would otherwise sit in the
 * ruleset reporting green — and even count toward `passCount` — while enforcing nothing. Now that
 * predicates are registrable (`align.config.ts`'s `hostRules` export, `docs/adr/002`), this only
 * fires for a genuinely unregistered name — a typo, a removed predicate a rule still references,
 * or (rare) a rule reaching `evaluateCustomHost` without having gone through the orchestrator's
 * guard step first (defense in depth, see `evaluateCustomHost` below). */
export class UnknownHostRuleError extends Error {
  constructor(
    public readonly ruleId: string,
    public readonly hostRuleName: string,
  ) {
    super(
      `Rule '${ruleId}' (custom.host) references host predicate '${hostRuleName}', which is not ` +
        `registered in align.config.ts's 'hostRules' export. This rule cannot be evaluated and ` +
        `would silently report green. Register a predicate named '${hostRuleName}' in 'hostRules', ` +
        `fix the typo, or remove the rule (and re-run \`align build\` if it came from a doc).`,
    );
    this.name = 'UnknownHostRuleError';
  }
}

/**
 * Load-time validation, run in `GateOrchestrator.check`'s vacuous-green guard step: every
 * `custom.host` rule's `hostRuleName` must name a registered host predicate. The CLI composition
 * root derives `registeredHostPredicates` from the loaded config's `hostRules` export (core stays
 * framework-free — it only ever sees the name set, never the config-loading mechanism) and passes
 * the real set to `GateOrchestrator`'s constructor; a repo with no `hostRules` export passes an
 * empty set here, same as before registration existed. Fail-fast on the first offender, same
 * convention as the sibling validators.
 */
export function validateHostRules(rules: readonly RuleIR[], registeredHostPredicates: ReadonlySet<string>): void {
  for (const rule of rules) {
    if (rule.kind !== 'custom.host') continue;
    if (!registeredHostPredicates.has(rule.hostRuleName)) {
      throw new UnknownHostRuleError(rule.id, rule.hostRuleName);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Predicate registration surface (docs/proposals/rule-expansion-evaluation.md §B.0, ADR 002).
// ---------------------------------------------------------------------------------------------

/**
 * Narrow, typed input a host predicate receives — pure data, no I/O (CODING_BEST_PRACTICES.md
 * §14/15's "functional core" discipline applies to predicates too): the freshly re-scanned graph
 * (ADR 005 — always fresh, never cached), a convenience component lookup, and the flat file list.
 * Predicates read this and return `HostViolation[]`; they never touch the filesystem, network, or
 * clock themselves, and `evaluateCustomHost` (below) is itself I/O-free, matching every other
 * `RuleEvaluator` in this package.
 */
export interface HostRuleContext {
  readonly graph: DependencyGraph;
  readonly componentOf: (file: RepoRelativePath) => ComponentName | undefined;
  readonly files: readonly RepoRelativePath[];
}

/**
 * What a predicate returns — deliberately minimal so authoring one stays a few lines
 * (docs/proposals/rule-expansion-evaluation.md §B.0's "cost to ship: low"). `range`/`snippet`
 * default to the violating file's line 1 / scanned first-line snippet when omitted — core (never
 * the predicate) fingerprints the violation, defaults `fixHint` to `'manual-review'`, and hoists
 * the rule's `.because()` text, mirroring exactly what every other `RuleEvaluator` does for its
 * own violations.
 */
export interface HostViolation {
  readonly file: RepoRelativePath;
  readonly range?: SourceRange;
  readonly snippet?: string;
  readonly message: string;
}

/** A registered host predicate: pure `(ctx) -> violations`, no I/O — same doctrine as
 * `RuleEvaluator` (`rules/evaluators.ts`), scoped to one rule kind's worth of host-defined logic.
 * Authored in `align.config.ts`'s `hostRules` export, keyed by the name a `custom.host` rule's
 * `hostRuleName` references (`c.custom.host('name')`, `dsl/index.ts`). */
export type HostPredicate = (ctx: HostRuleContext) => readonly HostViolation[];

/** The registered-predicate map, keyed by `hostRuleName`. `ReadonlyMap` (not a plain object) —
 * the CLI composition root builds this once from `align.config.ts`'s `hostRules` export and
 * injects it into `GateOrchestrator`; core never constructs one itself. */
export type HostPredicateRegistry = ReadonlyMap<string, HostPredicate>;

/** Thrown when a registered predicate itself throws while evaluating — the reference-validity
 * invariant's sibling (ADR 008 amendment): a buggy predicate must surface as gate `error`, never a
 * silent pass (an uncaught exception mid-evaluation would otherwise abort the whole check with an
 * unattributed stack trace) and never a silently-dropped violation set. Caught here, re-thrown
 * with rule/predicate attribution so the orchestrator's evaluation-loop guard (`orchestrator.ts`)
 * can turn it into a `GateResult` the same way it already does for scan/reference-validity
 * failures. */
export class HostPredicateExecutionError extends Error {
  constructor(
    public readonly ruleId: string,
    public readonly hostRuleName: string,
    public readonly predicateError: unknown,
  ) {
    super(
      `Rule '${ruleId}' (custom.host) predicate '${hostRuleName}' threw while evaluating: ` +
        `${predicateError instanceof Error ? predicateError.message : String(predicateError)} — ` +
        `a host predicate must be a pure function over its HostRuleContext (no I/O); fix it in ` +
        `align.config.ts's 'hostRules' export.`,
    );
    this.name = 'HostPredicateExecutionError';
  }
}

/**
 * Untrusted-mode's custom.host refusal (ADR 014). `--untrusted`/`--ir-only` never registers any
 * host predicates (there is nothing to register them FROM — align.config.ts is never imported in
 * that mode), so every `custom.host` rule is structurally unevaluatable there, permanently, not
 * just until someone fixes a registration typo. Distinct from `UnknownHostRuleError` (a fixable
 * config bug: register the predicate, fix the name, or remove the rule) — this error tells the
 * truth about *why* it can't be fixed by editing `align.config.ts`: that file is never read under
 * `--untrusted` at all. Refusing outright (never silently skipping the rule) follows the same
 * false-green doctrine as `UnknownHostRuleError` and the reference-validity invariant (ADR 008
 * amendment) — a silently-dropped rule would report green while enforcing nothing.
 */
export class UntrustedCustomHostRuleError extends Error {
  constructor(public readonly ruleIds: readonly string[]) {
    super(
      `--untrusted refuses to evaluate ${ruleIds.length} custom.host rule(s): ${ruleIds.join(', ')}. ` +
        `A custom.host predicate is host-side code by definition, and --untrusted's entire guarantee ` +
        `is that no repo-controlled code executes — there is no predicate registry to consult because ` +
        `align.config.ts is never imported in this mode. Options: run \`align check\` without ` +
        `--untrusted on a repo you trust to execute code, or remove/replace these rules with a ` +
        `portable arch.*/security.manifest.* kind before running \`align export-ir\` again.`,
    );
    this.name = 'UntrustedCustomHostRuleError';
  }
}

/**
 * `--untrusted`'s pre-flight guard (ADR 014), called by the CLI before constructing the
 * orchestrator — mirrors `validateHostRules`'s fail-fast-on-first-offender convention but collects
 * every offending rule id in one error instead of stopping at the first, since there is no
 * "register the missing one and re-run" loop to support here (registration is categorically
 * unavailable, not just incomplete).
 */
export function assertNoCustomHostRules(rules: readonly RuleIR[]): void {
  const ids = rules.filter((r): r is CustomHostRule => r.kind === 'custom.host').map((r) => r.id);
  if (ids.length > 0) throw new UntrustedCustomHostRuleError(ids);
}

function normalizeHostViolation(
  rule: CustomHostRule,
  hv: HostViolation,
  nodeByFile: ReadonlyMap<RepoRelativePath, DependencyGraph['nodes'][number]>,
): Violation {
  const range = hv.range ?? { startLine: 1, endLine: 1 };
  // No I/O here either (evaluateCustomHost stays as pure as every other RuleEvaluator) — the
  // fallback reuses the node's already-scanned first-line snippet (DependencyGraphNode.snippet,
  // captured once at scan time, same field `arch.metric` reuses for its own file-level
  // violations) rather than re-reading the file.
  const snippet = hv.snippet ?? nodeByFile.get(hv.file)?.snippet ?? hv.message;
  const id = computeFingerprint(['custom', rule.id, hv.file, String(range.startLine), hv.message]);
  return {
    id,
    ruleId: toRuleId(rule.id),
    category: 'architecture',
    severity: 'error',
    file: hv.file,
    range,
    snippet,
    fixHint: { code: 'manual-review' },
    ...(rule.provenance.because === undefined ? {} : { because: rule.provenance.because }),
    kind: 'custom',
    hostRuleName: rule.hostRuleName,
    detail: hv.message,
  };
}

/**
 * `custom.host`'s `RuleEvaluator` (dispatched from `rules/evaluators.ts`'s exhaustive switch,
 * ADR 002). Looks up the rule's predicate in the injected registry, builds its `HostRuleContext`
 * from the already-scanned graph (zero extra I/O), runs it, and normalizes every `HostViolation`
 * into a full `Violation` — the same fingerprint/baseline/fix-hint machinery every other rule kind
 * gets, so a custom.host violation is baseline-able and dedupes exactly like any other.
 */
export function evaluateCustomHost(
  rule: CustomHostRule,
  graph: DependencyGraph,
  predicates: HostPredicateRegistry,
): readonly Violation[] {
  const predicate = predicates.get(rule.hostRuleName);
  if (predicate === undefined) {
    // Defense in depth: `validateHostRules` (the orchestrator's pre-evaluation guard step) should
    // already have caught this — reachable only if a caller evaluates a rule without running the
    // guard first (e.g. `align explain`/`align build`'s dry-run passes call `evaluateRule`
    // directly). Same error type either way, so the message is identical.
    throw new UnknownHostRuleError(rule.id, rule.hostRuleName);
  }

  const nodeByFile = new Map(graph.nodes.map((n) => [n.file, n]));
  const componentOf = (file: RepoRelativePath): ComponentName | undefined => nodeByFile.get(file)?.component;
  const ctx: HostRuleContext = { graph, componentOf, files: graph.nodes.map((n) => n.file) };

  let results: readonly HostViolation[];
  try {
    results = predicate(ctx);
  } catch (err) {
    throw new HostPredicateExecutionError(rule.id, rule.hostRuleName, err);
  }

  return results.map((hv) => normalizeHostViolation(rule, hv, nodeByFile));
}
