import {
  buildScanHistoryContext,
  buildScanObservation,
  createScanHistoryProbe,
  observationsDiffer,
  type CheckRun,
  type RulesetIR,
  type ScanHistoryContext,
  type ScanHistoryProbe,
  type ScanObservationRecord,
} from '@spikedpunch/align-core';
import { readLastScanRecord, writeLastScanRecord } from './last-scan-file.js';
import { ALIGN_VERSION } from './telemetry/process-context.js';

/**
 * The CLI half of ADR 029: build the run's history context, and persist what it observed.
 *
 * **Who writes, and the rule behind the list** (ADR 029 §7.3, sharpened twice while implementing it):
 * a surface writes the record **only if it consulted the record for a transfer decision**.
 *
 * *The biconditional was wrong, and the second sharpening (2026-08-18, task #14) removes it.* Once
 * `store.applyMoves` gained the D015 refusal, consulting the record became what makes the refusal
 * exist. The surfaces that consult are `check` (both arms), both MCP tools, `agent run`, `upgrade`
 * (including its prune preview, which must reason from the SAME probe as the outcome), `baseline
 * prune` — and `init`, which is the one that cannot actually transfer: it scans with an EMPTY
 * baseline, so `applyMoves` has no orphan and returns before the probe is reached. It gets the real
 * probe anyway rather than a claim that this repository has no history, on the same grounds as its
 * `fileExists` argument. Three construction sites deliberately do NOT —
 * `baseline accept`, `baseline show` and `build --accept-new-into-baseline` pass `noScanHistory()`,
 * because they only ever `accept`/`show`/`snapshot` and have no scan scope in hand to build a real
 * probe from. That exemption is CLAUDE.md rule 4's, and it is pinned by
 * `core/test/existence-probe.test.ts` rather than asserted here. WRITING is the half the enumeration below restricts,
 * because it is the half that moves the temporal reference forward for everyone after it.
 *
 * **Consulting is *nearly* free, and the exception is worth stating rather than rounding off.** A
 * refusal inside `applyMoves` removes a candidate from the move-match set. Under `reconcileMoves`
 * (`align check`) that is purely conservative: the orphan is left alone. Under `store.prune` an orphan
 * with no match is DELETED, so there the same refusal converts a transfer into a deletion. That is
 * still the right outcome — the orphan's file is genuinely absent, all three ADR 028 mechanisms
 * declined, and prune's whole job is removing entries for violations that are gone, behind consent and
 * ADR 023's guards — but it is a destructive consequence of consulting, not an absence of one, and
 * `core/test/scan-history-move-refusal.test.ts` pins it deliberately rather than leaving it to be
 * discovered.
 * ADR 029 §7.3 already contained the counter-example to its own "iff" and did not notice: it names
 * `align upgrade` as a surface that transfers but deliberately does not write.
 * **The writers, enumerated by call site rather than by memory** (`grep persistScanObservation`):
 * `align check` (trusted), `align check --untrusted`, and BOTH MCP tools that call `freshCheck` —
 * `align_check` and `align_violations`. Four, not three: `align_violations` shares `freshCheck`, so it
 * consults the record, runs the same `reconcileMoves` and persists the same transfer, which makes it a
 * writer under the rule below whether or not anyone listed it. An earlier version of this comment said
 * three and was a sample presented as a census — the failure CLAUDE.md §1.3 is about.
 *
 * ADR 029 §7.3 as written names only `check`, and its damage argument is right while its enumeration
 * is not. The hazard is a surface that moves the temporal reference FORWARD without a transfer
 * decision having been made against it — run `align doctor` after a rename and the record already
 * shows the violation at its new path, so the next `check` refuses a legitimate rename. `explain`,
 * `build`, `doctor`, `init`, `agent run` and `upgrade` are all in that category and none of them
 * writes. MCP's `align_check` is not: it consults, decides, and persists exactly as the CLI command
 * does, and it is the surface an agent-only workflow uses *exclusively* — excluding it would leave
 * the mechanism permanently inert for align's stated primary consumer.
 */
export interface ScanHistory {
  /** Handed to `InMemoryBaselineStore` so `applyMoves` can refuse a transfer onto a candidate the
   * previous scan already reported (ADR 029 §6, LEDGER D015). */
  readonly probe: ScanHistoryProbe;
  /** The current scan's side of every comparison in ADR 029 §4 — the half the record cannot hold. */
  readonly context: ScanHistoryContext;
  /** The record as it stood BEFORE this run, kept so `persistScanObservation` can decide whether the
   * observation changed without reading the file a second time. Reading once also means a corrupt
   * record produces ONE warning per run rather than one per reader. */
  readonly previous: ScanObservationRecord | undefined;
}

/**
 * Open the repository's scan history: read the record once, build the probe and the context from it.
 *
 * Called before the scan, by every surface that can TRANSFER (the list above) — not by every surface
 * that constructs a baseline store; three of them pass `noScanHistory()` instead, for the reason given
 * above. Consulting is always safe (it can only add refusals); WRITING is what the
 * enumeration above restricts, and the two are separate decisions in separate functions for exactly
 * that reason.
 */
export function openScanHistory(
  rootDir: string,
  input: {
    readonly ruleset: RulesetIR;
    readonly excludes: readonly string[];
    readonly includeNestedCheckouts?: readonly string[];
  },
): ScanHistory {
  const context = buildScanHistoryContext({ alignVersion: ALIGN_VERSION, ...input });
  const previous = readLastScanRecord(rootDir);
  return { probe: createScanHistoryProbe(previous, context), context, previous };
}

const INCOMPLETE_HINT =
  'Install dependencies (or ground the empty component) and re-run to bring the record up to date.';

/**
 * ADR 029 §7.6 / LEDGER D025 — **an incomplete run must not overwrite a complete one.**
 *
 * The failure this closes: a run that is merely incomplete reports FEWER violations (an unresolved
 * specifier drops the edge, so the violation on it never fires; an ungrounded component evaluates its
 * rules over nothing). Persisting that replaces a sound record with a narrower one, and the next run
 * then answers `known: true, value: false` about a violation the previous complete scan had seen — so
 * the D015 refusal does not fire. One `align check` without `npm ci` silently disarms it, and nothing
 * announces that it has been disarmed.
 *
 * **A no-DOWNGRADE rule rather than a no-write-when-incomplete rule**, and the difference is not
 * cosmetic. Incompleteness is an ordinary standing state for real repositories, not an error: the
 * integration project reports `complete: false` at its pinned commit (48 unresolved external
 * specifiers), so "never write from an incomplete run" would mean the record is never written there
 * at all and the mechanism is permanently inert on exactly the repositories that have the most code.
 * The four transitions:
 *
 *   no record   → write (bootstrap; an incomplete record beats none, since every question it answers
 *                 `true` is still a sound positive observation)
 *   incomplete  → write (tracks the repository at the fidelity available)
 *   → complete    write (an upgrade in fidelity is never a loss)
 *   complete → incomplete   **decline**, and say so
 *
 * The cost, stated rather than discovered: a repository that becomes permanently incomplete freezes
 * its record at the last complete scan. That is benign for the only consumer — a frozen record refuses
 * only where a candidate genuinely coexisted with the orphan at that time, which is the D015 case — but
 * it is a real behaviour and the stderr line is what makes it visible instead of silent.
 */
function wouldDowngrade(previous: ScanObservationRecord | undefined, next: ScanObservationRecord): boolean {
  return previous !== undefined && previous.complete && !next.complete;
}

/**
 * Records what this run observed, subject to four constraints that are each a way of NOT writing.
 *
 * 1. **Never from an errored run** — and note what this constraint does NOT cover. It names one cause
 *    of "this run knows less than the repository contains"; a run that is merely INCOMPLETE
 *    (unresolved specifiers, an ungrounded component — `isRunComplete`) still writes, with fewer
 *    violations, over a sounder record. The next run's D015 refusal then does not fire for whatever
 *    dropped out. Never unsound (fewer refusals is pre-ADR-029 behaviour exactly), but the protection
 *    becomes variable in a way nobody can see. **Closed by constraint 4 below** (LEDGER D025); an
 *    earlier version of this comment left it as an accepted residual and justified that with a claim
 *    that was simply false — that refusing to write when incomplete would inert the mechanism on any
 *    repository with a standing `uncertainty` advisory, align's own included. `isRunComplete` does not
 *    consider `uncertainty` at all (`gates/advisories.ts`, and `advisories.test.ts` asserts it
 *    directly); align's own run is complete. The real constraint came from a different measurement —
 *    see `wouldDowngrade`. An errored run reports empty `observedFiles`,
 *    `observedViolations` and `componentMatchCounts` — deliberately, because it has no trustworthy
 *    scan scope to report (`untrustworthyScanScope`). Persisting that would turn "this run knows
 *    nothing" into the positive claim "the previous scan observed nothing", which is admissible next
 *    run and would read a component that matched 12 files as having always matched 0 — silencing the
 *    exact regression ADR 029 §6 exists to report. It would also destroy a sound record to do it.
 *    This constraint is not in ADR 029 §7; it is added by this implementation and amended in.
 *
 * 2. **Only when the observation changed** (§7.1), with `observedAt` excluded from the comparison.
 *    An unchanged repository must not have a file rewritten under it by a command users reasonably
 *    treat as read-only — `align check` is what runs in pre-commit hooks and CI.
 *
 * 3. **Never fatally** (§7.2). Read-only checkouts, sandboxed CI, a `.align/` owned by another user,
 *    and a full disk are all ordinary. A failed write costs the NEXT run its history — which reads as
 *    `known: false`, which is exactly today's behaviour — and a `check` that exited non-zero because
 *    it could not update a cache would be a far worse outcome than the one being protected against.
 *    Announced on stderr rather than swallowed: silence is how a mechanism stays broken.
 *
 * 4. **Never downgrading a complete record to an incomplete one** — see `wouldDowngrade` above for the
 *    defect, the four transitions and the cost. This is the constraint constraint 1 was missing: both
 *    are answers to "this run knows less than the repository contains", and shipping only the errored
 *    half was [S-09], fixed one arm and missed the other.
 */
export function persistScanObservation(rootDir: string, run: CheckRun, history: ScanHistory): void {
  if (run.verdict === 'error') return;
  try {
    const next = buildScanObservation(run, history.context, Date.now());
    if (wouldDowngrade(history.previous, next)) {
      console.error(
        'align: this scan did not resolve everything it was asked to, so the previous (complete) ' +
          `.align/last-scan.json was kept rather than replaced with a narrower observation. ${INCOMPLETE_HINT}`,
      );
      return;
    }
    if (!observationsDiffer(history.previous, next)) return;
    writeLastScanRecord(rootDir, next);
  } catch (err) {
    console.error(
      `align: could not update .align/last-scan.json (${err instanceof Error ? err.message : String(err)}). ` +
        'This does not affect the result above; the next run simply has no scan history to compare against.',
    );
  }
}
