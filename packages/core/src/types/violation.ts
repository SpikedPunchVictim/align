import type { ComponentName, RepoRelativePath, RuleId, ViolationId } from './branded.js';
import type { EdgeKind } from './graph.js';

// v1 executes 'architecture' and 'security' gates only ('types'/'lint'/'format' are the Stage 5
// tool-wrapping growth path, IMPLEMENTATION_PLAN.md); the union is fixed now so ADR 007/008's
// priority ordering and GateResult shape don't change when later gates add categories.
// CATEGORIES is the single source of truth (CODING_BEST_PRACTICES.md §12 "parse, don't
// validate" applied to a const-derived union instead of a zod schema) — `Category` is *derived*
// from the array, never hand-duplicated, so anything enumerating categories at runtime (e.g.
// `align skill`'s generated gate-list section, packages/cli/src/skill/gates.ts) reads the same
// array the type itself is built from and cannot silently drift from it.
export const CATEGORIES = ['architecture', 'security', 'types', 'lint', 'format'] as const;
export type Category = (typeof CATEGORIES)[number];

export type Severity = 'error' | 'warning' | 'info';

export interface SourceRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface CycleEdge {
  readonly from: RepoRelativePath;
  readonly to: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
}

// Short-code form, not prose — ADR 007: fixHint is structured, message text is rendered at the
// surface layer, never stored on the model itself.
export type FixHint =
  | { readonly code: 'remove-import'; readonly file: RepoRelativePath; readonly line: number }
  | { readonly code: 'relocate-shared-code'; readonly from: ComponentName; readonly to: ComponentName }
  | { readonly code: 'invert-dependency'; readonly owner: ComponentName }
  | { readonly code: 'break-cycle-edge'; readonly suggestedEdge: CycleEdge }
  | { readonly code: 'manual-review' }
  // `arch.metric` (max-LOC), promoted 2026-07-12 on kluster ruleset evidence
  // (IMPLEMENTATION_PLAN.md's Promotion log) — un-reserved from the comment below.
  | { readonly code: 'split-file'; readonly file: RepoRelativePath };
  // Reserved fix-hint codes arrive with their rule kinds (reserve, docs/ir-schema.md):
  // 'rename-to-match-pattern' (arch.naming) · 'reduce-fan-in' / 'reduce-fan-out' (arch.metric,
  // fan-in/fan-out/instability — still reserved pending their own evidence)

interface ViolationBase {
  readonly id: ViolationId; // snippet-hash fingerprint (ADR 006) — stable under unrelated edits
  readonly ruleId: RuleId;
  readonly category: Category;
  readonly severity: Severity;
  readonly file: RepoRelativePath;
  readonly range: SourceRange;
  readonly snippet: string; // exact source text at range — required (ADR 007/010: dedup + future
  // edit-block construction both depend on this)
  readonly fixHint: FixHint;
  readonly because?: string; // hoisted .because() / sourceQuote (ADR 002/011)
}

// Discriminated union, not optional-soup (CODING_BEST_PRACTICES.md §10) — each rule kind's
// structural fields are only present on its own variant.
export type Violation =
  | (ViolationBase & {
      readonly kind: 'no-dependency';
      /** The unmapped files the dependency was routed through, when it was — LEDGER D061.
       *
       * Absent for a direct edge, which is the overwhelming majority. Present when the target
       * belonged to no declared component and align contracted through it to reach the forbidden
       * one: without naming the relay, the report says `a` imports `b` via a specifier that mentions
       * neither, and the reader has nothing to act on. Never part of the fingerprint. */
      readonly relayedThrough?: readonly RepoRelativePath[];
      /** Which kind of import produced this edge — LEDGER D056. Carried so the message can say
       * "type-only", because a user comparing a red `arch.layers` against a green `arch.no-cycles`
       * on the SAME edge had nothing in either message explaining the disagreement. Never part of
       * the fingerprint. */
      readonly edgeKind: EdgeKind;
      readonly fromFile: RepoRelativePath;
      readonly toFile: RepoRelativePath;
      readonly fromComponent: ComponentName;
      readonly toComponent: ComponentName;
      readonly specifier: string;
      readonly line: number;
    })
  // ADR 017 Part A: `arch.no-dependency`'s `to` target is an external selector, not a component —
  // a distinct `kind` (not a reused 'no-dependency' with optional fields, CODING_BEST_PRACTICES.md
  // §10) because there is no `toComponent`/`toFile` to report (the target is a name-level
  // `ExternalPackageNode`, not a scanned file). `Violation.kind` already partitions more finely
  // than `RuleIR.kind` (e.g. 'layers' vs. 'no-dependency' both come from different rule kinds than
  // 'metric'/'custom'), so a new `Violation` kind here is not a new `RuleIR` kind — the ADR's "no
  // new rule kind" constraint is about the IR discriminant, not this finer-grained violation model.
  | (ViolationBase & {
      readonly kind: 'no-dependency-external';
      readonly fromFile: RepoRelativePath;
      readonly fromComponent: ComponentName;
      readonly toExternal: string; // ExternalPackageNode.id, e.g. 'external:node:child_process'
      readonly externalPackageName: string;
      readonly specifier: string;
      readonly line: number;
    })
  | (ViolationBase & {
      readonly kind: 'no-cycles';
      readonly chain: readonly CycleEdge[]; // per-edge detail, not just file names (ADR 004)
      readonly suggestedBreakEdge: CycleEdge;
      /** Every file in the strongly connected component this cycle was drawn from — LEDGER D054.
       *
       * align reports ONE cycle per SCC, because enumerating every cycle in a component is
       * exponential and an SCC is genuinely one architectural problem. But `chain` alone presents a
       * representative as if it were the whole finding: a user reads the violation count as a work
       * estimate, fixes the reported cycle, and watches a previously-hidden cycle in the same group
       * take its place with the count unchanged. Reported from a 50-package monorepo where align
       * said 12 and it took 17 distinct fixes.
       *
       * Carried as data rather than baked into the message so `--json`/MCP consumers can see the
       * group too. NOT part of the fingerprint — the id is `['no-cycles', ruleId, ...chain]`, and
       * adding to it would re-identify every baselined cycle entry in every repository. */
      readonly cycleGroup: readonly RepoRelativePath[];
    })
  | (ViolationBase & {
      readonly kind: 'layers';
      /** See `no-dependency`'s field of the same name (LEDGER D056). */
      readonly edgeKind: EdgeKind;
      readonly fromLayer: ComponentName;
      readonly toLayer: ComponentName;
      readonly fromFile: RepoRelativePath;
      readonly toFile: RepoRelativePath;
      readonly specifier: string;
      readonly line: number;
    })
  // ADR 017 Part A: `arch.layers`' `canDependOn` includes an external selector and this layer's
  // edge matched none of them — same "distinct kind, no component on the target side" rationale as
  // 'no-dependency-external' above.
  | (ViolationBase & {
      readonly kind: 'layers-external';
      readonly fromLayer: ComponentName;
      readonly fromFile: RepoRelativePath;
      readonly toExternal: string;
      readonly externalPackageName: string;
      readonly specifier: string;
      readonly line: number;
    })
  | (ViolationBase & {
      readonly kind: 'metric';
      // Literal today (only `loc` is promoted, IMPLEMENTATION_PLAN.md's Promotion log); grows to a
      // union alongside `RuleIR`'s `arch.metric.metric` when fan-in/fan-out/instability graduate.
      readonly metric: 'loc';
      readonly component: ComponentName;
      readonly value: number;
      readonly threshold: number;
    })
  // `custom.host` (registration surface, docs/proposals/rule-expansion-evaluation.md §B.0):
  // `detail` is the registered predicate's own `HostViolation.message` — the only kind whose
  // violation text comes from outside align's own evaluators, so it's kept as a distinct field
  // rather than folded into `because` (which stays reserved for the rule author's `.because()`).
  | (ViolationBase & {
      readonly kind: 'custom';
      readonly hostRuleName: string;
      readonly detail: string;
    })
  // `security.manifest.*` (ADR 013, promoted 2026-07-12 on probe evidence). `file` (ViolationBase)
  // is the declaring package.json; `depName`/`specifier` are structured, never folded into prose
  // (ADR 007 rule 2/6) — this is exactly the "specifier string, not a sentence" discipline the
  // probe's own payload-shape recommendation names.
  | (ViolationBase & {
      readonly kind: 'manifest-source-hygiene';
      readonly depName: string;
      readonly specifier: string; // literal, lockfile-resolved when available
      readonly sourceType: 'git' | 'http' | 'file' | 'link';
    })
  | (ViolationBase & {
      readonly kind: 'manifest-new-dependency';
      readonly depName: string;
      readonly specifier: string;
      readonly depField: 'dependencies' | 'devDependencies'; // name-level, runtime+dev only (ADR 013)
    });
  // Reserved variant (arrives with its rule kind — reserve pending evidence, docs/ir-schema.md):
  // 'naming' { actual, pattern }

/**
 * Human-facing prose is rendered at the surface, never stored on the model (ADR 007 rule 2:
 * measured 3.6x token reduction, 182 -> 51 tokens/violation, by keeping this out of the machine
 * payload entirely).
 */
/** Names the unmapped files a forbidden dependency was routed through — LEDGER D061. Empty for a
 * direct edge. Without it the message reports a dependency on a file the specifier never mentions,
 * which reads as align malfunctioning rather than as a real path. */
function relaySuffix(relayedThrough: readonly RepoRelativePath[] | undefined): string {
  if (relayedThrough === undefined || relayedThrough.length === 0) return '';
  return (
    ` The dependency is routed through ${relayedThrough.join(' -> ')}, which ` +
    `${relayedThrough.length === 1 ? 'matches' : 'match'} no component selector — a file in no component cannot ` +
    'hold a dependency on your behalf, so align follows the edge through it. Give it a component, or remove the re-export.'
  );
}

/** " (type-only import)" when the edge was erased at runtime, else nothing — LEDGER D056. Shared by
 * `no-dependency` and `layers` so the two cannot drift into describing the same edge differently. */
function edgeKindSuffix(kind: EdgeKind): string {
  return kind === 'type-only' ? ' The import is type-only (erased at runtime), which arch.layers/arch.no-dependency count by default and arch.no-cycles does not; pass includeTypeOnly: false on the rule to exclude it.' : '';
}

export function renderViolationMessage(v: Violation): string {
  switch (v.kind) {
    case 'no-dependency':
      return (
        `${v.fromFile} (component '${v.fromComponent}') imports ${v.toFile} ` +
        `(component '${v.toComponent}') via '${v.specifier}' at line ${v.line}, which rule ` +
        `'${v.ruleId}' forbids.` +
        relaySuffix(v.relayedThrough) +
        edgeKindSuffix(v.edgeKind) +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'no-dependency-external':
      return (
        `${v.fromFile} (component '${v.fromComponent}') imports external package ` +
        `'${v.externalPackageName}' via '${v.specifier}' at line ${v.line}, which rule ` +
        `'${v.ruleId}' forbids.` + (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'no-cycles': {
      const lastHop = v.chain[v.chain.length - 1];
      const nodeNames: string[] = v.chain.map((e) => String(e.from));
      if (lastHop !== undefined) nodeNames.push(String(lastHop.to));
      const path = nodeNames.join(' -> ');
      // Only when the group is BIGGER than the cycle shown (LEDGER D054). The overwhelming majority
      // of cycles are two files that are the whole group, and appending group prose to every one of
      // those is noise that teaches people to skim the message.
      const inCycle = new Set(nodeNames);
      const groupNote =
        v.cycleGroup.length > inCycle.size
          ? ` These ${v.cycleGroup.length} files form one mutually-dependent group ` +
            `(${v.cycleGroup.join(', ')}); align reports one cycle per group, so breaking the cycle above ` +
            'may leave other cycles among these files.'
          : '';
      return (
        `Import cycle of ${v.chain.length} edge(s) detected: ${path}.` +
        groupNote +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    }
    case 'layers':
      return (
        `${v.fromFile} (layer '${v.fromLayer}') imports ${v.toFile} (layer '${v.toLayer}') via ` +
        `'${v.specifier}' at line ${v.line}, which rule '${v.ruleId}' forbids.` +
        edgeKindSuffix(v.edgeKind) +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'layers-external':
      return (
        `${v.fromFile} (layer '${v.fromLayer}') imports external package '${v.externalPackageName}' ` +
        `via '${v.specifier}' at line ${v.line}, which rule '${v.ruleId}' forbids.` +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'metric':
      return (
        `${v.file} (component '${v.component}') is ${v.value} lines, exceeding rule '${v.ruleId}'s ` +
        `max-${v.metric} limit of ${v.threshold} lines.` + (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'custom':
      return (
        `${v.file}: ${v.detail} (rule '${v.ruleId}', host predicate '${v.hostRuleName}').` +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'manifest-source-hygiene':
      return (
        `${v.file} declares '${v.depName}' via a non-registry (${v.sourceType}) specifier ` +
        `'${v.specifier}', which rule '${v.ruleId}' flags for human sign-off.` +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'manifest-new-dependency':
      return (
        `${v.file} declares dependency '${v.depName}' (${v.depField}) via '${v.specifier}', not yet ` +
        `accepted into the baseline, which rule '${v.ruleId}' flags.` +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    default: {
      const exhaustive: never = v;
      throw new Error(`unhandled violation kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
