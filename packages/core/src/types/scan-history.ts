import type { ComponentName, RepoRelativePath, RuleId, ViolationId } from './branded.js';

/**
 * "Was this true the last time align scanned this repository?" — ADR 029, and the answer to a
 * defect class rather than a defect.
 *
 * Seven ledger rows turn on one missing fact, and four of the ledger's numbered severity zeros are
 * among them (D001, D010, D011, D015; recounted 2026-08-18 — there are six, and quoting a denominator
 * that grows every time this project finds one is how a comment becomes wrong without being edited):
 * **every align run is amnesiac.** A scan is compared against the baseline — a record of accepted
 * *violations* — and against nothing at all on the question of what the scan itself saw. Absence is
 * then read as evidence, which is the exact inference ADR 028 exists to refuse. ADR 028's three
 * retention mechanisms are each an attempt to recover, from a single snapshot, a fact that only
 * exists across two.
 *
 * INJECTED, NEVER CONSTRUCTED HERE, the same seam as `FileExistenceProbe`: the CLI reads
 * `.align/last-scan.json` and hands the record in; core does the reasoning and imports `node:fs`
 * nowhere.
 *
 * WHAT THIS IS NOT. The record says what align **observed**. That is not what **existed**. Git
 * knows the second and this does not, and the distinction decides what a consumer may do with an
 * answer — see `Recalled` and ADR 029 §5 below.
 */

/**
 * A three-state answer: `known: false` means the history cannot speak to this question, which is
 * distinct from an answer of `false`.
 *
 * A DISCRIMINATED UNION, deliberately, and not `boolean | 'unknown'` or `T | undefined`. A
 * three-state answer encoded as a string makes `if (probe.wasFileObserved(f))` compile and read
 * `'unknown'` as *true*; encoded as `undefined` it reads as *false*. Either way a caller who forgets
 * the third state gets a silent wrong answer, and in half the call sites the wrong answer is the
 * destructive one. This union cannot be consumed without discriminating.
 */
export type Recalled<T> = { readonly known: false } | { readonly known: true; readonly value: T };

/** The two constructors, so no call site hand-writes the object shape (and so the `known: false`
 * arm has one greppable origin). */
export const UNKNOWN: Recalled<never> = { known: false };
export function recalled<T>(value: T): Recalled<T> {
  return { known: true, value };
}

/**
 * ADR 029 §3. Consumers ask narrow, named questions; **nobody reads the record**.
 *
 * THE RULE GOVERNING EVERY ANSWER (ADR 029 §5, and the doctrinal core of the whole design): history
 * is admissible as a **refusal**, never as a **permission**. A consumer may use an answer to decline
 * a destructive inference it would otherwise make. It may never use one to authorize an inference it
 * would otherwise decline.
 *
 * That is not conservatism for its own sake; it follows from what the record can prove. "This
 * violation was observed here last scan" is a positive fact that soundly refutes a move — the
 * candidate predates the source file's disappearance, so the violation cannot have moved onto it.
 * "This file was not observed last scan" proves only that align did not look — never that the file
 * was absent. The first supports a refusal; the second supports nothing.
 *
 * The rule is what makes the mechanism safe to ship before its consumers — with nothing reading the
 * record, no state it can be in changes any behaviour — and it is the argument for it being safe
 * afterwards too: a consumer that only ever ADDS refusals cannot introduce a false green, whatever
 * the record contains, including hand-edited, truncated or forged.
 *
 * **Note precisely what that second half rests on.** It is a property of the CONSUMER, not of this
 * interface. `wasFileObserved` returning `known: true, value: false` is a permission-shaped answer,
 * and nothing here can stop a caller treating it as one; the type system enforces that the third
 * state is handled, not that the second is used soundly. So a reviewer of any consumer has one
 * question to ask, and this comment exists so that they ask it: *does this code turn an answer into
 * a refusal, or into an authorization?*
 *
 * VALIDITY IS A PROPERTY OF THE QUESTION, NOT OF THE RECORD (ADR 029 §4). The probe — never the
 * caller — decides whether a recorded fact is still admissible for the inference the question exists
 * to serve, and returns `known: false` when it is not. A single global staleness flag would discard
 * all four answers whenever any one went stale; per-question invalidation keeps the sound ones and,
 * more importantly, keeps each predicate small enough that a consumer's author can check it.
 */
export interface ScanHistoryProbe {
  /** The question that closes the severity zeros: *was this candidate already violating, at this
   * path, last scan?* If it was, it predates the source file's disappearance and cannot be where
   * that violation moved to. `known: false` when the record is absent, written by a different align
   * version, or the cited rule's definition has changed since. */
  wasViolationObservedAt(file: RepoRelativePath, ruleId: RuleId, contentFingerprint: ViolationId): Recalled<boolean>;
  /** A COUNT, not `wasGrounded`. "Matched 12 files last scan, 0 now" and "matched 0 last scan, 0
   * now" are different situations and only the first is a regression; the count answers the boolean
   * question and more, at identical cost. `known: false` when the record is absent, the scan scope
   * changed, or anything that could move this component's count changed — which includes an
   * EARLIER component's selector, since classification is first-match-wins. */
  observedMatchCount(component: ComponentName): Recalled<number>;
  /** `known: false` only when the record is absent or unreadable — this question is about the
   * record's own provenance, so no other invalidation applies to it. */
  previousScopeIdentity(): Recalled<string>;
}

/** One violation as the record remembers it: enough to answer `wasViolationObservedAt` and nothing
 * more. `contentFingerprint` (ADR 006's file-independent ruleId+snippet hash) is the identity that
 * survives a rename, which is precisely the identity a move-transfer question needs. */
export interface ObservedViolation {
  readonly file: RepoRelativePath;
  readonly ruleId: RuleId;
  readonly contentFingerprint: ViolationId;
}

/**
 * `.align/last-scan.json` — what the immediately preceding scan of this repository, **on this
 * machine**, **by this version of align**, observed.
 *
 * GITIGNORED FOR IDENTITY, NOT FOR CHURN (ADR 029 §1). Diff noise would be a cost argument; this is
 * a correctness one. A record written on machine A is not evidence about machine B's checkout —
 * sparse checkouts, partial clones, volume case-sensitivity and an uninstalled workspace all change
 * what a scan legitimately observes. Committing it would let one machine's observation authorize
 * another machine's deletion, which is shape S-10 with a version-control system in front of it.
 *
 * N = 1. Every question in `ScanHistoryProbe` is "compared with the immediately preceding scan". A
 * deeper history buys trend analysis no consumer has asked for and multiplies the "which record is
 * authoritative" problem this design exists to keep small. Raise N when a consumer needs it.
 */
export interface ScanObservationRecord {
  /** Bumped when this shape changes incompatibly; a reader that does not recognise the version
   * treats the record as absent. ADR 028's Consequences recorded the cost of NOT having this on
   * `McpCheckPayload` — every rename after 0.2.0 is an unsignallable break — and this field is that
   * lesson applied before the fact, for twenty bytes. */
  readonly recordVersion: 1;
  /** The scanner's extension set and walk rules are version-dependent, so a record written by a
   * different align is not evidence about what this one would have seen. */
  readonly alignVersion: string;
  /** Hash over the effective scan scope — `excludes` and the nested-checkout opt-outs. A narrower
   * or wider scope observes a different set of files for reasons that have nothing to do with the
   * repository changing. */
  readonly scopeIdentity: string;
  /**
   * Whether the recording run resolved everything it was asked to — `isRunComplete`, ADR 023's second
   * axis: no `missing-dependencies` advisory and no ungrounded component. (An `uncertainty` advisory
   * does NOT make a run incomplete; align's own repository carries one and is complete.)
   *
   * **Not admissibility — write eligibility.** No question on `ScanHistoryProbe` consults this, and
   * that is deliberate: an incomplete scan still *observed* what it reported, so a recorded violation
   * remains a sound positive fact. What an incomplete run gets wrong is what it OMITS, and an
   * omission is invisible in the record by construction. So this field exists for the writer
   * (`persistScanObservation`), which refuses to replace a record from a complete run with one from
   * an incomplete run — see LEDGER D025 for the defect that required it.
   */
  readonly complete: boolean;
  /** Reporting and staleness only. NEVER an input to an inference: "the record is 20 minutes old"
   * says nothing about whether a file moved, and a time-based admissibility rule would make the
   * safety of a destructive inference depend on how long a developer went to lunch for. */
  readonly observedAt: number;
  /**
   * *(Removed 2026-08-19 — LEDGER D032.)* The record used to carry every observed path, per scan
   * domain, for `wasFileObserved`. That question's only licensed consumer — `store.prune`'s retention
   * — turned out to be unsound with N=1: "the previous scan did not observe this file" is true of any
   * file deleted before that scan, so retaining on it would make every entry whose file vanished more
   * than one run ago permanently unprunable. With no sound consumer, the field was **64% of the record
   * measured on align's own repository** (16KB of 25KB, 355 paths) — written into someone else's
   * checkout on every run that changes anything. Add it back when a sound consumer exists, the same
   * rule §1 states for raising N.
   */
  /** Per component: how many files its selector matched, and the identity of everything that could
   * move that number. See `componentSelectorIdentities` for why the identity is a PREFIX hash
   * rather than a hash of the component's own selector. */
  readonly components: Readonly<Record<string, ComponentObservation>>;
  /** Per rule: a hash of the rule's definition, so `wasViolationObservedAt` can refuse to answer
   * about a rule that has been redefined since. Per-rule and not a whole-ruleset hash: a single
   * global hash forces all-or-nothing invalidation, and its real hazard is not the wasted answers
   * but that its false discards teach callers to ignore it. */
  readonly ruleDefinitions: Readonly<Record<string, string>>;
  /** Every violation the scan reported, **baselined or not**.
   *
   * The "or not" is deliberate and is the field an earlier draft of this design omitted. Being
   * baselined is a property of the baseline at write time, not of the scan — so a record that held
   * only unbaselined violations would silently answer a DIFFERENT question after someone ran
   * `align baseline accept`, and the question it answers is the one guarding a destructive
   * inference.
   *
   * Bounded by violation count, not file count: cheap on the repositories where it matters least
   * and proportionate on the ones where it matters most. */
  readonly violations: readonly ObservedViolation[];
  /**
   * Observations an EARLIER scan made that this one could not, kept because they still bear on an
   * unresolved baseline entry (ADR 029 §2.1, LEDGER **D030**).
   *
   * **A separate field, not merged into `violations`, and that is the whole point.** `violations`
   * means "what this scan observed" and must keep meaning exactly that; a carried-forward fact is not
   * an observation this scan made, and writing it there would make the record lie about its own
   * provenance. `wasViolationObservedAt` consults the union, because for its question — *did align
   * ever report this violation at this path while the orphan still existed?* — both are equally sound
   * evidence.
   *
   * **Why the mechanism is needed at all.** The D015 refusal requires the previous scan to have
   * observed BOTH the orphan at its own path and the candidate at its. The run that first refuses also
   * rewrites the record, and by then the orphan's file is deleted — so the evidence that justified the
   * refusal is destroyed by the very run that acted on it, and the NEXT run transfers. Measured: the
   * refusal survived exactly one check and the forgery landed on the second. Coexistence is a fact
   * about the past; a snapshot rewritten every run cannot hold it, so it is retained explicitly.
   *
   * **It converges.** An entry is retained only while a baseline entry still names that exact
   * violation at that exact path. The moment a human resolves it — accepting the candidate, pruning
   * the orphan, or restoring the file — the entry stops being retained and the record shrinks. There
   * is no timer and no cap, because the bound is the baseline itself.
   */
  readonly retained: readonly ObservedViolation[];
}

export interface ComponentObservation {
  readonly matchCount: number;
  /** See `ScanObservationRecord.components`. */
  readonly selectorIdentity: string;
}

/** The current scan's side of every comparison in ADR 029 §4 — the half the record cannot hold,
 * because "changed" needs both. Built once per run from the live config and ruleset. */
export interface ScanHistoryContext {
  readonly alignVersion: string;
  readonly scopeIdentity: string;
  readonly ruleDefinitions: ReadonlyMap<RuleId, string>;
  readonly componentSelectorIdentities: ReadonlyMap<ComponentName, string>;
}
