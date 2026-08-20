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
 * Thrown when one predicate returns two *distinct* findings that align cannot tell apart — LEDGER
 * D063, the fourth refusal in this module's vacuous-green family (`UnknownHostRuleError`,
 * `UntrustedCustomHostRuleError`, `HostPredicateExecutionError`) and the only one caused by
 * repo-authored code rather than by a missing or unavailable registration.
 *
 * **The defect.** A `custom.host` violation's identity is `['custom', ruleId, file, message]` — no
 * line number, by the same rule every other evaluator follows, so that a comment inserted above a
 * finding does not orphan its baseline entry. Two findings from the same predicate, in the same
 * file, carrying the same message therefore hash to ONE fingerprint. Reproduced against the built
 * 0.2.0 binary: a predicate emitting three findings on lines 1, 2 and 3 of `src/index.ts` against a
 * baseline holding ONE accepted entry reported `verdict: green`, `baselinedCount: 3`, and
 * `baselineDebt: {previous: 1, current: 1, delta: 0}`. Two findings no human had ever seen were
 * suppressed by consent given to a third, and the debt line — the one instrument a human would audit
 * — confirmed that nothing had changed.
 *
 * **Introduced by a fix, and shipped in exactly one version.** `9102847` (2026-08-06, "stop folding a
 * line number into the custom.host fingerprint") removed `String(range.startLine)` from the parts
 * list to stop baseline churn — a real problem, correctly diagnosed. What the line number had ALSO
 * been doing was keeping two findings apart, and nothing asked what else the field was carrying
 * before it was dropped. `git tag --contains 9102847` is `v0.2.0` alone; `v0.1.4`'s copy of this file
 * still has the line number in it, so 0.1.x churns and does not collapse. The remedy for churn was
 * never in dispute — it just needed this guard beside it.
 *
 * **Why this refuses instead of disambiguating.** Every other rule kind takes its distinctness from
 * structural coordinates core computes itself (`from`/`to`/`specifier` for the edge rules,
 * `manifest.file`/`dep.name` for the manifest rules, one-per-file for `arch.metric`) — whether those
 * coordinates are *sufficient* is a separate open question, measured and filed under SHAPES.md S-14,
 * and not a claim made here. `custom.host` has no coordinates at all: the predicate is the only
 * thing in the system that knows whether two findings are one problem or two. Every way core could
 * guess is worse than asking:
 *
 * - *Number them by position* — fixing the first finding shifts the rest down one, silently
 *   re-pointing accepted entries at findings nobody reviewed. That is precisely the consent-forging
 *   this store's move-transfer logic (ADR 027/028) exists to prevent.
 * - *Fall back to the line number* — restores the baseline churn the line-free fingerprint was
 *   adopted to remove, and makes acceptance order-dependent on the predicate's iteration order.
 * - *Collapse them into one finding* — turns one person's acceptance of one occurrence into standing
 *   consent for every future occurrence in that file. It is the false green, renamed.
 *
 * So align stops and says what it cannot decide. The remedy is one line in the predicate and it
 * improves the report too: three violations that read identically are not usable by the human
 * reading them, baselines or no baselines.
 *
 * **This was a doc comment before it was a guard**, which is the reusable lesson. `HostViolation`'s
 * own documentation has told predicate authors to put the distinguishing detail in `message` since
 * the fingerprint went line-free — and nothing checked that they had. CLAUDE.md's rule 5: a doc
 * comment asserting a safety property is a claim to verify, not evidence.
 */
export class HostViolationCollisionError extends Error {
  constructor(
    public readonly ruleId: string,
    public readonly hostRuleName: string,
    public readonly file: RepoRelativePath,
    /** The colliding text. Named `hostMessage` because `Error.message` is the rendered explanation. */
    public readonly hostMessage: string,
    public readonly count: number,
  ) {
    super(
      `Rule '${ruleId}' (custom.host) predicate '${hostRuleName}' returned ${count} different ` +
        `findings for '${file}' that all carry the message "${hostMessage}". align identifies a ` +
        `custom.host finding by rule + file + message and never by line number (a line number would ` +
        `orphan the baseline entry as soon as anything above the finding moved), so these ${count} ` +
        `are one signature: accepting one would silently accept the others, including findings ` +
        `added later that nobody has reviewed. Refusing instead of guessing. Fix: in ` +
        `align.config.ts's 'hostRules' export, give each finding a message that identifies it — the ` +
        `symbol, the offending value, the import specifier — so the ${count} findings read ` +
        `differently to a human and hash differently to the baseline.`,
    );
    this.name = 'HostViolationCollisionError';
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
 *
 * **`message` — not `range` — is what makes two findings distinct, and align now enforces it.**
 * Every `computeFingerprint` call site in this codebase deliberately excludes line numbers
 * (`baseline/fingerprint.ts:8-9`: "never line numbers"), `custom.host` included: the fingerprint
 * is `['custom', rule.id, file, message]`. That keeps a baseline entry alive across a line shift
 * (a comment or import inserted above the violation). It also means two `HostViolation`s from the
 * same predicate, same `file`, same `message`, on different lines are one signature to the
 * baseline. So if a predicate can emit more than one *distinct* finding per file, put the
 * distinguishing detail in `message` (the symbol name, the offending value, the specifier) — never
 * rely on `range`/line number to separate them.
 *
 * Until LEDGER D063 that paragraph was the whole mechanism: advice, unchecked, and a predicate that
 * ignored it produced a green run over findings nobody had accepted. `evaluateCustomHost` now
 * refuses the collision outright (`HostViolationCollisionError`). Emitting the *same* finding twice
 * — every field equal — is still fine and is reported once.
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

/** The `custom.host` arm of the `Violation` union. Named because `refuseOnCollision` below needs
 * `detail`, which only this arm has — carrying `Violation` there would force a narrowing branch that
 * can never be taken. */
type CustomViolation = Extract<Violation, { readonly kind: 'custom' }>;

function normalizeHostViolation(
  rule: CustomHostRule,
  hv: HostViolation,
  nodeByFile: ReadonlyMap<RepoRelativePath, DependencyGraph['nodes'][number]>,
): CustomViolation {
  const range = hv.range ?? { startLine: 1, endLine: 1 };
  // No I/O here either (evaluateCustomHost stays as pure as every other RuleEvaluator) — the
  // fallback reuses the node's already-scanned first-line snippet (DependencyGraphNode.snippet,
  // captured once at scan time, same field `arch.metric` reuses for its own file-level
  // violations) rather than re-reading the file.
  const snippet = hv.snippet ?? nodeByFile.get(hv.file)?.snippet ?? hv.message;
  // Deliberately excludes range.startLine (fingerprint.ts:8-9's "never line numbers" — every other
  // computeFingerprint call site in this codebase upholds this; this one used to be the exception).
  // A line shift (a comment or import inserted above the violation) must not orphan the baseline
  // entry. The consequence — two HostViolations in the same file with the same message are one
  // signature — is no longer left to the author to remember: `refuseOnCollision` below rejects the
  // pair (LEDGER D063).
  const id = computeFingerprint(['custom', rule.id, hv.file, hv.message]);
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

  return refuseOnCollision(rule, results.map((hv) => normalizeHostViolation(rule, hv, nodeByFile)));
}

/**
 * LEDGER D063's guard: one fingerprint must mean one finding, or align refuses to report at all.
 *
 * Runs on the NORMALIZED violations rather than the raw `HostViolation`s so the comparison sees the
 * same values the baseline will: a defaulted `range` and a defaulted `snippet` are what get written
 * to `.align/baseline.json`, and two findings that differ only in a field align discards are not
 * distinguishable no matter what the predicate intended.
 *
 * Two violations sharing an `id` are *the same finding reported twice* only if everything align can
 * observe about them agrees — `id` already covers rule/file/message, so `range` and `snippet` are
 * what remain. That case (two overlapping detection passes in one predicate) collapses to one
 * violation, which is honest: there is one problem and align reports one. Anything else is two
 * problems wearing one name, and the run errors.
 */
function refuseOnCollision(rule: CustomHostRule, violations: readonly CustomViolation[]): readonly Violation[] {
  const byId = new Map<string, CustomViolation[]>();
  for (const v of violations) {
    const group = byId.get(v.id);
    if (group === undefined) byId.set(v.id, [v]);
    else group.push(v);
  }
  if (byId.size === violations.length) return violations; // the overwhelmingly common path

  const deduped: CustomViolation[] = [];
  for (const group of byId.values()) {
    // A group is only ever created with one member already in it, so `[0]` is present; the check is
    // what `noUncheckedIndexedAccess` requires to say so.
    const first = group[0];
    if (first === undefined) continue;
    if (!group.every((v) => sameObservableFinding(first, v))) {
      throw new HostViolationCollisionError(rule.id, rule.hostRuleName, first.file, first.detail, group.length);
    }
    deduped.push(first);
  }
  return deduped;
}

/** What a `custom.host` finding carries beyond its fingerprint: `id` already accounts for rule,
 * file and message, and every other field on a normalized host violation is a constant of the rule
 * (`ruleId`, `category`, `severity`, `fixHint`, `because`, `kind`, `hostRuleName`) or is derived
 * from the message (`detail`). Only `range` and `snippet` can differ between two findings that
 * share an id — enumerated by reading `normalizeHostViolation` above, not inferred, and it is that
 * function a future field would have to be added to. */
function sameObservableFinding(a: CustomViolation, b: CustomViolation): boolean {
  return (
    a.range.startLine === b.range.startLine && a.range.endLine === b.range.endLine && a.snippet === b.snippet
  );
}
