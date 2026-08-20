import type { DependencyGraph, ScanBlindSpot, ScanBlindSpotReason, UncertaintyMarker, UncertaintyReason } from '../types/graph.js';
import type { ExternalPackageNode } from '../types/graph.js';
import type { RepoRelativePath } from '../types/branded.js';
import type { RuleIR } from '../types/ir.js';
import { findUngroundedExternalSelectors } from '../rules/external-match.js';
import type { BaselineEntry } from '../baseline/store.js';
import type { Violation } from '../types/violation.js';
import type { Advisory, CheckRun } from './types.js';

/**
 * Whether a set of advisories reflects a fully-resolved dependency graph — `false` iff a
 * `missing-dependencies` advisory is present (built below, when unresolvable external specifiers
 * are found). This is the ONE place the `missing-dependencies` literal is compared against —
 * `isRunComplete` (below) delegates to it for the `CheckRun`-shaped callers, and a caller that only
 * holds a bare advisories array (no full `CheckRun` to build) can call it directly instead of
 * re-deriving the same fact with its own `.some(...)`.
 */
export function areAdvisoriesComplete(advisories: readonly Advisory[]): boolean {
  return !advisories.some((a) => a.kind === 'missing-dependencies');
}

/**
 * Every errored gate and its message, as one interpolatable phrase — LEDGER D047.
 *
 * **This exists because it was already written twice.** `errored-run.ts`'s ADR 023 tier-1 refusal
 * and `packages/agent`'s initial-check refusal had each built
 * `gates.filter(status === 'error').map(g => \`${g.gate} gate: ${g.errorMessage ?? 'unknown error'}\`).join('; ')`
 * independently, down to the `|| 'a gate errored'` fallback. D047 needed it a third time (the MCP
 * `align_violations` refusal) and a fourth was one edit away. ADR 023 exists because five copies of
 * a related asymmetry drifted apart; this is the same story one step earlier.
 *
 * **Empty means "nothing to describe", and only that.** `''` is returned when no gate errored, so a
 * caller appending it unconditionally cannot manufacture prose about an error that did not happen.
 * It is never `''` for an errored run: `deriveVerdict` sets `verdict: 'error'` only when some gate
 * has `status: 'error'`, and a gate that errored without a message still renders as
 * `"<gate> gate: unknown error"`.
 *
 * Both prior copies ended in `|| 'a gate errored'`, and that arm was unreachable in both — `join`
 * returns `''` only for an empty list, which is precisely the case this function now answers with
 * `''` on purpose. Dropped rather than carried forward: a defensive branch no input can reach reads
 * as a case someone considered, and the next reader has to re-derive that it cannot happen.
 */
export function describeErroredGates(run: CheckRun): string {
  const errored = run.gates.filter((g) => g.status === 'error');
  return errored.map((g) => `${g.gate} gate: ${g.errorMessage ?? 'unknown error'}`).join('; ');
}

/**
 * Whether a `CheckRun` resolved everything it was asked to. This is the ONE
 * shared predicate for that axis (ADR 023's "second axis: incomplete ≠ errored"): it started as an
 * expression inlined at the MCP payload builder's `complete` field
 * (`payload/builder.ts`, `!run.advisories.some((a) => a.kind === 'missing-dependencies')`), and
 * would have become a second, driftable copy the moment a consumer outside the payload builder
 * needed the same check — which is exactly what happened: `errored-run.ts`'s tier-2 incomplete-scan
 * guard needs it too, to decide whether `align baseline prune` may safely delete. ADR 023 names
 * this pattern directly — five independent copies of a related asymmetry (errored vs. "fixed") is
 * why that ADR exists at all. Both `buildMcpCheckPayload` and the CLI's incomplete-run guard call
 * this function; neither re-derives it from `run.advisories`.
 */
export function isRunComplete(run: CheckRun): boolean {
  // TWO axes, not one (added 2026-08-17, LEDGER D011). `areAdvisoriesComplete` covers unresolvable
  // external specifiers. An UNGROUNDED component is the second way a scan can evaluate less than it
  // was asked to: a declared component matched zero files, so every rule scoped to it evaluated over
  // nothing and its violations vanish from the run — indistinguishable, downstream, from those
  // violations being fixed.
  //
  // Reproduced 2026-08-17: repoint a component's selector at a path that no longer exists (with
  // `empty: 'until-populated'`, the policy `align init` writes) and `align baseline prune` printed
  // `Pruned 1 fixed violation(s)`, exit 0, baseline emptied — while `align check` had just warned
  // "1 component(s) matched no files (ungrounded, provisionally green)". align knew and deleted
  // anyway. ADR 028's retention mechanisms structurally cannot see this: the files ARE observed,
  // they are merely unclassified.
  //
  // Routed through ADR 023 tier 2 rather than a fourth guard, deliberately. Tier 2 already means
  // "this scan evaluated real rules but not all of them, so deletion is refused unless you say
  // otherwise" — which is exactly the situation — and it is OVERRIDABLE, so an architecture-first
  // repo that legitimately has empty components can still prune with `--allow-incomplete`. A
  // non-overridable guard here is what trapped legitimate repositories last time (LEDGER D002).
  //
  // THREE axes (added 2026-08-19, LEDGER D043). An ERRORED run satisfies both axes above trivially
  // — no `missing-dependencies` advisory fired and `ungroundedComponents` is `[]` because nothing
  // got far enough to look — so this predicate used to answer "yes, it resolved everything" about a
  // run that evaluated no rule at all. Measured on the wire: `align check --json` on a repo with a
  // stale component selector printed `"verdict": "error"` beside `"complete": true`, with every
  // other field honestly zeroed.
  //
  // `orchestrator.ts`'s `untrustworthyScanScope()` is the same judgement, already made: it forces
  // FOUR sibling fields to their knows-nothing value on every errored early return, precisely so no
  // consumer reads a completeness claim off a run that has none. `complete` belongs to that set and
  // was outside it only because it is derived rather than stored — which made it invisible to the
  // `Pick` that makes the compiler enumerate those returns [S-09].
  //
  // Placed here rather than at the payload builder deliberately. A manifest scanner that throws
  // errors the SECURITY gate while the architecture pipeline runs to completion, so that run reaches
  // the ordinary return with a real scan scope — a payload-level patch keyed off the zeroed fields
  // would have missed it, and every non-payload consumer besides.
  //
  // ADR 023's two tiers are unaffected: tier 1 (`refuseIfRunErrored`, no override) precedes tier 2 at
  // both destructive call sites, so no errored run reaches the overridable guard. The change is what
  // a FUTURE site calling only tier 2 gets — a refusal instead of a pass.
  return run.verdict !== 'error' && areAdvisoriesComplete(run.advisories) && run.ungroundedComponents.length === 0;
}

/**
 * Groups uncertainty markers by reason (ADR 004's uncertainty vocabulary) into one advisory per
 * reason, each naming its own affected-file count (Stage 2 polish over a single blended count): a
 * lone "N specifiers could not be resolved" told an agent something was uncertain without saying
 * whether it's an asset import (expected, ignorable) or an unresolvable specifier (worth
 * investigating) — those are very different signals bundled into noise.
 *
 * Unresolvable EXTERNAL package specifiers are additionally collapsed into a single
 * `missing-dependencies` advisory instead of a per-import wall. This is derived from the scan itself
 * (the markers) — NOT a `node_modules` heuristic — so it fires on a partial install too (e.g. align
 * installed but the target repo's own deps absent), which is exactly the false-green case: without the
 * external edges, any external-edge rule would false-green. The one advisory suppresses the wall and
 * warns the check is provisional (docs/adr/proposals/deep-import-provenance/reconciled-build-order.md #1).
 */
export function buildUncertaintyAdvisories(uncertain: readonly UncertaintyMarker[]): Advisory[] {
  if (uncertain.length === 0) return [];

  // One-pass partition: unresolvable external-package specifiers vs everything else (avoids an
  // O(n²) filter that mattered at 1000s of markers on an uninstalled repo).
  const missing: UncertaintyMarker[] = [];
  const remaining: UncertaintyMarker[] = [];
  for (const marker of uncertain) {
    if (marker.reason === 'unresolvable-specifier' && isExternalPackageSpecifier(marker.specifier)) {
      missing.push(marker);
    } else {
      remaining.push(marker);
    }
  }

  const missingDepsAdvisory: Advisory | undefined =
    missing.length === 0
      ? undefined
      : {
          kind: 'missing-dependencies',
          message:
            `${missing.length} external specifier(s) across ${new Set(missing.map((m) => m.file)).size} ` +
            'file(s) could not be resolved — dependencies appear uninstalled or incomplete; install ' +
            'dependencies for a complete architecture check.',
        };

  const byReason = new Map<UncertaintyReason, UncertaintyMarker[]>();
  for (const marker of remaining) {
    const list = byReason.get(marker.reason);
    if (list === undefined) byReason.set(marker.reason, [marker]);
    else list.push(marker);
  }

  const advisories = [...byReason.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, markers]) => ({
      kind: 'uncertainty',
      message:
        `${markers.length} specifier(s) across ${new Set(markers.map((m) => m.file)).size} file(s) ` +
        `could not be resolved with certainty and were excluded from the graph — reason: ${reason}.`,
    }));

  return missingDepsAdvisory === undefined ? advisories : [missingDepsAdvisory, ...advisories];
}

/** A specifier that is not relative and not absolute is treated as an external package import for
 * the missing-dependencies collapse. Node builtins (`node:fs`, bare `fs`) resolve to `external` in
 * the scanner and therefore never appear as `unresolvable-specifier`; anything left in that reason
 * that isn't a relative/absolute path is assumed to be a missing npm package. A `#`-prefixed
 * specifier is a Node subpath import (package-INTERNAL, mapped via the package's own `imports`
 * field), not an external dependency — so an unresolvable `#foo` must NOT collapse into
 * `missing-dependencies` (which would wrongly flag the verdict provisional). */
function isExternalPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#');
}

/**
 * Which `ScanBlindSpotReason` kinds earn a per-scan advisory, and — just as deliberately — which do
 * not. The RECORD is complete: every blind spot the walk finds lands on `graph.blindSpots` and
 * `CheckRun.blindSpots`, and that record is what protects a baseline entry from being deleted or
 * transferred (ADR 028's whole point). This set governs only what `align check` PRINTS every run.
 *
 * `excluded` and `default-excluded-dir` are deliberately absent. The user authored the `excludes`
 * patterns themselves and `node_modules`/`dist`/`coverage` are excluded by design in every repo, so
 * an advisory naming them fires on literally every scan and says nothing the user did not already
 * decide — the reliable way to train a human to stop reading advisories. They are still recorded,
 * so retention still protects entries under them, and `prune`/`init` still name the reason at the
 * moment an entry is actually retained, which is the moment it is actionable.
 *
 * The four that ARE reported all share the property that the user could not have predicted them
 * from their own config: a nested checkout appears with a generated name (ADR 027), an unreadable
 * directory is a permissions accident, an unparseable file is corruption the user can actually fix,
 * and a symlink is invisible data loss the walk cannot follow.
 */
const ADVISORY_BLIND_SPOT_REASONS: ReadonlySet<ScanBlindSpotReason['kind']> = new Set([
  'nested-checkout',
  'unreadable',
  'unparseable',
  'not-regular-file',
]);

/** Paths for one advisory line: deduped, sorted, and capped — the `describeUnverifiablePrunes`
 * (`cli/src/unverified-prune.ts`) precedent, so every capped path list in align reads the same. A
 * blind spot list is unbounded in principle (a repo can hold any number of symlinks), and an
 * advisory that dumps hundreds of paths is not more informative than one that names five. */
function describePaths(labels: readonly string[]): string {
  const unique = [...new Set(labels)].sort((a, b) => a.localeCompare(b));
  const shown = unique.slice(0, 5);
  const more = unique.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`;
}

/** The reason phrase for a whole GROUP of blind spots, which is a different question from
 * `describeBlindSpotReason`'s per-spot phrase: `unreadable` carries a distinct `error` per path and
 * `excluded` a distinct `pattern`, so a group header must not borrow the first member's detail and
 * silently attribute it to the rest. Per-path detail is appended to the path itself below. */
function describeBlindSpotKind(kind: ScanBlindSpotReason['kind']): string {
  switch (kind) {
    case 'nested-checkout':
      return 'nested git checkout';
    case 'excluded':
      return 'matched an excludes pattern';
    case 'default-excluded-dir':
      return 'always-excluded directory name';
    case 'unreadable':
      return 'the directory could not be read';
    case 'unparseable':
      return 'the file is present but could not be parsed — corrupt is not the same as absent, so align will not treat its entries as fixed';
    case 'not-regular-file':
      return 'not a regular file (symlink, FIFO or socket — the walk does not follow these, so an entire symlinked subtree is absent from the graph)';
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled scan blind spot kind: ${String(exhaustive)}`);
    }
  }
}

/** `path`, plus the reason's own per-path detail when it has one — so an `unreadable` group shows
 * which error hit which directory instead of one error standing in for all of them. */
function labelBlindSpot(spot: ScanBlindSpot): string {
  switch (spot.reason.kind) {
    case 'unreadable':
    case 'unparseable':
      return `${spot.path} (${spot.reason.error})`;
    case 'excluded':
      return `${spot.path} (${spot.reason.pattern})`;
    case 'default-excluded-dir':
    case 'nested-checkout':
    case 'not-regular-file':
      return spot.path;
    default: {
      const exhaustive: never = spot.reason;
      throw new Error(`unhandled scan blind spot reason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * ADR 028, generalizing task #25's nested-checkout advisory: name the paths this scan declined to
 * look at, so a directory the walk skipped is never indistinguishable from one that was simply
 * empty. That is exactly the false-green shape ADR 008's reference-validity amendment and ADR 003's
 * `empty:` policy both exist to prevent — a component whose files all lived under a silently-skipped
 * path evaluates vacuously green with zero signal.
 *
 * One advisory per reason kind, not one per path, and only for the kinds in
 * `ADVISORY_BLIND_SPOT_REASONS` above (read its comment before adding one — the omissions are the
 * design). The nested-checkout arm keeps its own `kind` and its own remediation sentence: it is the
 * only reason with a config-level fix (`includeNestedCheckouts`), and UPGRADING.md's 0.2.0 note
 * names that advisory kind by string.
 *
 * See `components/registry.ts`'s `blindSpotsMatchingSelector` for the sharper, per-component
 * diagnosis this advisory alone cannot give — it fires once per scan, not once per component.
 */
/**
 * Edges the graph contains but no rule can evaluate — LEDGER D052's safety net.
 *
 * **Why this exists separately from the defect it shipped with.** Every evaluator opens its loop
 * with `if (fromNode === undefined || toNode === undefined) continue`, so an edge whose target was
 * never scanned is skipped by every rule, silently. D052 reached a user as a green verdict on a
 * repository with forty emptied allowlists precisely because of that silence: a resolution bug put
 * cross-package edges into `dist/`, the walk had never scanned `dist/`, and nothing said so. The
 * resolution bug was the cause; the silence is what let it survive review, a release, and align's
 * own self-dogfood.
 *
 * So the rule this encodes is not about `dist` at all: **align must never hold an edge it cannot
 * evaluate without saying so.** Any future resolution quirk that lands outside the scan reports
 * here instead of vanishing.
 *
 * Measured on align's own repository the day it was written: 820 such edges, bucketing entirely
 * into `dist` (818) and `build` (2) — the second being D053, a separate defect this advisory found
 * rather than one it was written for.
 *
 * Internal edges only. `externalEdges` are a disjoint collection resolved against `externalNodes`;
 * folding them in would fire on every repository that imports anything from npm.
 */
export function buildUnevaluatableEdgeAdvisories(graph: DependencyGraph): Advisory[] {
  const nodeFiles = new Set(graph.nodes.map((n) => n.file));
  const unevaluatable = graph.edges.filter((e) => !nodeFiles.has(e.to));
  if (unevaluatable.length === 0) return [];

  const targets = [...new Set(unevaluatable.map((e) => e.to))];
  // The directory that most likely explains it, named because it is where the fix goes. Derived
  // from the targets themselves rather than from a list of known-excluded names — this advisory
  // must keep working for a cause nobody has thought of yet.
  const dirs = [...new Set(targets.map((t) => t.split('/').slice(0, -1).join('/')).filter((d) => d !== ''))];
  const sample = targets.slice(0, 5);

  return [
    {
      kind: 'unevaluatable-edges',
      message:
        `${unevaluatable.length} import edge(s) point at files this scan did not include, so NO RULE can ` +
        `evaluate them — a dependency routed through one of these is invisible to every architecture rule, ` +
        `and a green verdict does not cover it. Affected target(s): ${sample.join(', ')}` +
        `${targets.length > sample.length ? `, +${targets.length - sample.length} more` : ''}. ` +
        `Most often the target directory is excluded from the scan (align skips \`node_modules\` and ` +
        `\`.git\` at any depth, and build-output names like \`dist\`, \`build\`, \`out\`, ` +
        `\`coverage\` where they sit at a package root) — if one of ` +
        `${dirs.slice(0, 3).join(', ')} holds real source, that is the thing to fix.`,
    },
  ];
}

export function buildScanBlindSpotAdvisories(blindSpots: readonly ScanBlindSpot[]): Advisory[] {
  const byKind = new Map<ScanBlindSpotReason['kind'], ScanBlindSpot[]>();
  for (const spot of blindSpots) {
    if (!ADVISORY_BLIND_SPOT_REASONS.has(spot.reason.kind)) continue;
    const list = byKind.get(spot.reason.kind);
    if (list === undefined) byKind.set(spot.reason.kind, [spot]);
    else list.push(spot);
  }

  const advisories: Advisory[] = [];

  const checkouts = byKind.get('nested-checkout');
  if (checkouts !== undefined && checkouts.length > 0) {
    advisories.push({
      kind: 'nested-checkout-skipped',
      message:
        `${checkouts.length} nested git checkout(s) auto-excluded from the scan (each has its own .git and ` +
        `is not part of this project's architecture): ${describePaths(checkouts.map((s) => s.path))}. If one of ` +
        "these is genuinely part of the project (e.g. a submodule), add it to align.config.ts's " +
        'includeNestedCheckouts export.',
    });
  }

  for (const kind of [...byKind.keys()].filter((k) => k !== 'nested-checkout').sort()) {
    const spots = byKind.get(kind);
    if (spots === undefined || spots.length === 0) continue;
    advisories.push({
      kind: 'scan-blind-spot',
      message:
        `${spots.length} path(s) were not scanned — ${describeBlindSpotKind(kind)}: ` +
        `${describePaths(spots.map(labelBlindSpot))}. A baseline entry under one of these is unobservable ` +
        'this scan, not fixed, so align retains it rather than pruning or transferring it (ADR 028).',
    });
  }

  return advisories;
}

/**
 * The `ungroundedComponents` precedent (ADR 008's 2026-07-13 amendment), applied to `external(...)`
 * selectors (ADR 017 Part A): a selector matching zero nodes in `graph.externalNodes` skips ADR
 * 008 reference-validity (banning an absent package is correctly vacuously green) but is surfaced
 * here as an advisory rather than left silently, permanently green — so a typo
 * (`external('lodsh')`) is visible. Unlike `ungroundedComponents` (its own dedicated `CheckRun`
 * field, since it feeds a distinct greenfield-mode UX), this rides the existing generic `Advisory`
 * bucket — the ADR's own wording is "surfaced as an advisory", not "a new CheckRun field".
 */
export function buildUngroundedExternalSelectorAdvisories(rules: readonly RuleIR[], externalNodes: readonly ExternalPackageNode[]): Advisory[] {
  const ungrounded = findUngroundedExternalSelectors(rules, externalNodes);
  if (ungrounded.length === 0) return [];

  return ungrounded
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.pattern.localeCompare(b.pattern))
    .map((u) => ({
      kind: 'ungrounded-external-selector',
      message:
        `external selector '${u.pattern}' (rule '${u.ruleId}') matches no external package/builtin seen ` +
        `in this scan — vacuously green, not confirmed. Likely a typo, or the package genuinely isn't imported.`,
      ruleIds: [u.ruleId],
    }));
}

/**
 * A starting point pending evidence (this repo promotes thresholds on measured data, not
 * intuition — IMPLEMENTATION_PLAN.md's Promotion log), not a tuned constant. 20% is picked as
 * "clearly more than incidental drift" without being so tight that an ordinary handful of added
 * lines fires it on every check — reporting on any growth at all (+1 line) would be noise, not
 * signal. Revisit once real repos show what growth rate actually precedes a file becoming
 * unmanageable.
 */
const BASELINE_GROWTH_ADVISORY_RATIO = 0.2;

/**
 * FRAGILE #8 (bug hunt 2026-08-03): `arch.metric`'s fingerprint is deliberately file-identity-only
 * (`rules/evaluators.ts`'s `evaluateMetric`, `computeFingerprint(['metric', rule.id, node.file])`)
 * — changing it to fold in the measured value would invalidate every existing baseline entry and
 * force a policy call on what "accepted debt" means for a growing file (a design question, not a
 * bug fix). So the fingerprint stays exactly as-is; instead, a file whose current `loc` has grown
 * well past what was accepted (`BaselineEntry.acceptedValue`, `baseline/store.ts`) is surfaced here
 * as an advisory. This never changes `verdict` or baseline identity — a baselined violation stays
 * baselined, no re-accept — it only makes growth visible instead of structurally invisible again.
 *
 * Silently produces no advisory (never throws) for:
 *  - non-`metric` violations — they have no comparable `value`/`acceptedValue` pair
 *  - a violation whose baseline entry has no recorded `acceptedValue` — either a legacy entry
 *    accepted before this field existed, or accepted by a version that only recorded it for
 *    `metric` kinds (which is every version, but the optionality is what makes both cases safe)
 *  - a violation that isn't baselined at all — `entriesByFingerprint` simply has no entry for it
 */
export function buildBaselineGrowthAdvisories(violations: readonly Violation[], baselineEntries: readonly BaselineEntry[]): Advisory[] {
  const entriesByFingerprint = new Map<BaselineEntry['fingerprint'], BaselineEntry>();
  for (const entry of baselineEntries) entriesByFingerprint.set(entry.fingerprint, entry);

  const advisories: Advisory[] = [];
  for (const v of violations) {
    if (v.kind !== 'metric') continue;
    const entry = entriesByFingerprint.get(v.id);
    if (entry?.acceptedValue === undefined) continue; // legacy/unbaselined — no advisory, no crash
    if (v.value <= entry.acceptedValue * (1 + BASELINE_GROWTH_ADVISORY_RATIO)) continue;

    advisories.push({
      kind: 'baseline-growth',
      message:
        `${v.file} was baselined at ${entry.acceptedValue} lines and has grown to ${v.value} lines ` +
        `(rule '${v.ruleId}') — more than ${Math.round(BASELINE_GROWTH_ADVISORY_RATIO * 100)}% over the ` +
        'accepted value. The baseline entry is unchanged; consider splitting the file, or re-accept to ' +
        'record the new size.',
      ruleIds: [v.ruleId],
    });
  }
  return advisories.sort((a, b) => a.message.localeCompare(b.message));
}
