/**
 * `align telemetry` — turns the raw `.align/telemetry.jsonl` accretion into the report a
 * human/coordinator actually reads (IMPLEMENTATION_PLAN.md's telemetry spec): check-latency
 * percentiles, top-firing rules, time-to-green per rule, dead rules, baseline-vs-fix ratio, and
 * friction ranking. Reads only — never writes telemetry.jsonl itself.
 */
import * as fs from 'node:fs';
import type { BaselineEvent, CheckEvent, ErrorEvent, TelemetryEnvelope, ViolationTransitionEvent } from '@spikedpunch/align-core';
import { telemetryJsonlPath } from '../align-dir.js';
import { loadConfig } from '../config.js';

export const DEFAULT_TELEMETRY_FILE = '.align/telemetry.jsonl';

export interface TelemetryReportOptions {
  readonly file?: string;
  readonly json: boolean;
}

interface ParsedLines {
  readonly envelopes: readonly TelemetryEnvelope[];
  readonly skipped: number;
}

/** Malformed lines (a hand-edited file, a truncated write from a crashed process) are skipped, not
 * fatal — this is an analysis tool over an append-only log, not a schema boundary anything else
 * depends on (unlike `.align/generated-rules.json`'s "corrupted is never absent" discipline). */
function parseLines(raw: string): ParsedLines {
  const envelopes: TelemetryEnvelope[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === 'object' && 'event' in parsed && 'command' in parsed) {
        envelopes.push(parsed as TelemetryEnvelope);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { envelopes, skipped };
}

function percentile(sortedAsc: readonly number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

interface LatencyStats {
  readonly count: number;
  readonly p50?: number;
  readonly p90?: number;
  readonly p99?: number;
}

function latencyStats(wallMsValues: readonly number[]): LatencyStats {
  const sorted = [...wallMsValues].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  const p99 = percentile(sorted, 99);
  return {
    count: sorted.length,
    ...(p50 !== undefined ? { p50 } : {}),
    ...(p90 !== undefined ? { p90 } : {}),
    ...(p99 !== undefined ? { p99 } : {}),
  };
}

interface RuleFiringCount {
  readonly ruleId: string;
  readonly count: number;
}

interface TimeToGreen {
  readonly ruleId: string;
  readonly resolvedCount: number;
  readonly avgMs: number;
  readonly medianMs: number;
}

interface FrictionCount {
  readonly errorKind: string;
  readonly count: number;
}

interface SegmentLatency {
  readonly key: string;
  readonly checks: number;
  readonly p50?: number;
}

export interface TelemetrySummary {
  readonly totalEvents: number;
  readonly skippedLines: number;
  readonly checkLatencyMs: LatencyStats;
  readonly topFiringRules: readonly RuleFiringCount[];
  readonly timeToGreen: readonly TimeToGreen[];
  readonly deadRules: readonly string[];
  readonly baselineVsFix: { readonly baselined: number; readonly resolved: number; readonly ratio?: number };
  readonly friction: readonly FrictionCount[];
  readonly segments: { readonly bySession: readonly SegmentLatency[]; readonly byAlignVersion: readonly SegmentLatency[] };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midValue = sorted[mid];
  const midValueBefore = sorted[mid - 1];
  if (midValue === undefined) return 0;
  return sorted.length % 2 === 0 && midValueBefore !== undefined ? (midValueBefore + midValue) / 2 : midValue;
}

function computeTimeToGreen(envelopes: readonly TelemetryEnvelope[]): readonly TimeToGreen[] {
  // Processed in file order (append-only log — the order events were written IS the order they
  // occurred) so an `appeared` is always seen before the `resolved` that closes it out.
  const openByFingerprint = new Map<string, { readonly ruleId: string; readonly ts: number }>();
  const deltasByRule = new Map<string, number[]>();

  for (const env of envelopes) {
    if (env.event.kind !== 'violation-appeared' && env.event.kind !== 'violation-resolved') continue;
    const event = env.event as ViolationTransitionEvent;
    if (event.kind === 'violation-appeared') {
      openByFingerprint.set(event.violationFingerprint, { ruleId: event.ruleId, ts: env.ts });
      continue;
    }
    const opened = openByFingerprint.get(event.violationFingerprint);
    if (opened === undefined) continue; // resolved without a seen appear (pre-dates this telemetry log) — not measurable
    openByFingerprint.delete(event.violationFingerprint);
    const deltaMs = env.ts - opened.ts;
    const list = deltasByRule.get(opened.ruleId);
    if (list === undefined) deltasByRule.set(opened.ruleId, [deltaMs]);
    else list.push(deltaMs);
  }

  return [...deltasByRule.entries()]
    .map(([ruleId, deltas]) => ({
      ruleId,
      resolvedCount: deltas.length,
      avgMs: deltas.reduce((a, b) => a + b, 0) / deltas.length,
      medianMs: median(deltas),
    }))
    .sort((a, b) => b.resolvedCount - a.resolvedCount);
}

async function computeDeadRules(rootDir: string, firedRuleIds: ReadonlySet<string>): Promise<readonly string[]> {
  try {
    const { ruleset } = await loadConfig(rootDir);
    return ruleset.rules.map((r) => r.id).filter((id) => !firedRuleIds.has(id));
  } catch {
    // align.config.ts is unreadable/missing right now (e.g. summarizing a JSONL copied off a
    // different checkout) — dead-rule analysis needs today's active ruleset to mean anything;
    // every other section of the report is still computed from the log alone.
    return [];
  }
}

export async function buildTelemetrySummary(rootDir: string, filePath: string): Promise<TelemetrySummary> {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const { envelopes, skipped } = parseLines(raw);

  const checkWallMs = envelopes.filter((e) => e.event.kind === 'check').map((e) => (e.event as CheckEvent).wallMs);
  const appearedCounts = new Map<string, number>();
  for (const e of envelopes) {
    if (e.event.kind !== 'violation-appeared') continue;
    const ruleId = (e.event as ViolationTransitionEvent).ruleId;
    appearedCounts.set(ruleId, (appearedCounts.get(ruleId) ?? 0) + 1);
  }
  const topFiringRules = [...appearedCounts.entries()]
    .map(([ruleId, count]) => ({ ruleId, count }))
    .sort((a, b) => b.count - a.count);

  const resolvedCount = envelopes.filter((e) => e.event.kind === 'violation-resolved').length;
  const baselinedCount = envelopes
    .filter((e) => e.event.kind === 'baseline' && (e.event as BaselineEvent).action === 'accept')
    .reduce((sum, e) => sum + ((e.event as BaselineEvent).counts.accepted ?? 0), 0);

  const frictionCounts = new Map<string, number>();
  for (const e of envelopes) {
    if (e.event.kind !== 'error') continue;
    const kind = (e.event as ErrorEvent).errorKind;
    frictionCounts.set(kind, (frictionCounts.get(kind) ?? 0) + 1);
  }
  const friction = [...frictionCounts.entries()].map(([errorKind, count]) => ({ errorKind, count })).sort((a, b) => b.count - a.count);

  const bySession = segmentLatency(envelopes, (e) => e.sessionId);
  const byAlignVersion = segmentLatency(envelopes, (e) => e.alignVersion);

  const total = baselinedCount + resolvedCount;
  return {
    totalEvents: envelopes.length,
    skippedLines: skipped,
    checkLatencyMs: latencyStats(checkWallMs),
    topFiringRules,
    timeToGreen: computeTimeToGreen(envelopes),
    deadRules: await computeDeadRules(rootDir, new Set(appearedCounts.keys())),
    baselineVsFix: { baselined: baselinedCount, resolved: resolvedCount, ...(total > 0 ? { ratio: baselinedCount / total } : {}) },
    friction,
    segments: { bySession, byAlignVersion },
  };
}

function segmentLatency(envelopes: readonly TelemetryEnvelope[], keyOf: (e: TelemetryEnvelope) => string): readonly SegmentLatency[] {
  const byKey = new Map<string, number[]>();
  for (const e of envelopes) {
    if (e.event.kind !== 'check') continue;
    const key = keyOf(e);
    const list = byKey.get(key);
    const wallMs = (e.event as CheckEvent).wallMs;
    if (list === undefined) byKey.set(key, [wallMs]);
    else list.push(wallMs);
  }
  return [...byKey.entries()]
    .map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const p50 = percentile(sorted, 50);
      return { key, checks: values.length, ...(p50 !== undefined ? { p50 } : {}) };
    })
    .sort((a, b) => b.checks - a.checks);
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printHuman(summary: TelemetrySummary): void {
  console.log(`align telemetry — ${summary.totalEvents} event(s) read${summary.skippedLines > 0 ? ` (${summary.skippedLines} malformed line(s) skipped)` : ''}`);

  console.log('\ncheck latency:');
  if (summary.checkLatencyMs.count === 0) {
    console.log('  no check events recorded yet.');
  } else {
    console.log(
      `  p50=${fmtMs(summary.checkLatencyMs.p50)}  p90=${fmtMs(summary.checkLatencyMs.p90)}  ` +
        `p99=${fmtMs(summary.checkLatencyMs.p99)}  (n=${summary.checkLatencyMs.count})`,
    );
  }

  console.log('\ntop-firing rules:');
  if (summary.topFiringRules.length === 0) {
    console.log('  none.');
  } else {
    for (const r of summary.topFiringRules.slice(0, 20)) console.log(`  ${r.count.toString().padStart(4)}  ${r.ruleId}`);
  }

  console.log('\ntime-to-green per rule (appeared -> resolved):');
  if (summary.timeToGreen.length === 0) {
    console.log('  no appear->resolve transitions observed yet.');
  } else {
    for (const t of summary.timeToGreen) {
      console.log(`  ${t.ruleId}: avg=${fmtMs(t.avgMs)} median=${fmtMs(t.medianMs)} (n=${t.resolvedCount})`);
    }
  }

  console.log('\ndead rules (in the active ruleset, never fired):');
  console.log(summary.deadRules.length === 0 ? '  none.' : summary.deadRules.map((r) => `  ${r}`).join('\n'));

  console.log('\nbaseline-vs-fix:');
  console.log(
    `  baselined=${summary.baselineVsFix.baselined}  resolved(fixed)=${summary.baselineVsFix.resolved}` +
      (summary.baselineVsFix.ratio !== undefined ? `  baseline-ratio=${(summary.baselineVsFix.ratio * 100).toFixed(0)}%` : ''),
  );

  console.log('\nfriction (error events by kind):');
  if (summary.friction.length === 0) {
    console.log('  none.');
  } else {
    for (const f of summary.friction) console.log(`  ${f.count.toString().padStart(4)}  ${f.errorKind}`);
  }

  if (summary.segments.bySession.length > 1) {
    console.log('\nby session (check latency p50):');
    for (const s of summary.segments.bySession) console.log(`  ${s.key}: ${s.checks} check(s), p50=${fmtMs(s.p50)}`);
  }
  if (summary.segments.byAlignVersion.length > 1) {
    console.log('\nby align version (check latency p50):');
    for (const s of summary.segments.byAlignVersion) console.log(`  ${s.key}: ${s.checks} check(s), p50=${fmtMs(s.p50)}`);
  }
}

export async function runTelemetryReport(rootDir: string, options: TelemetryReportOptions): Promise<number> {
  const filePath = telemetryJsonlPath(rootDir, options.file);
  const summary = await buildTelemetrySummary(rootDir, filePath);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  printHuman(summary);
  return 0;
}
