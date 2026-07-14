/**
 * Probe 3 — rescan economics.
 * Loop: modify one source file in the writable kluster copy -> full rescan (in-process,
 * warm V8, fresh resolver each iteration, exactly what an MCP-server re-check would do).
 * Measures wall-time mean/p95 and heap growth across 20 iterations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { KLUSTER_ROOT, SCAN_ROOTS } from './kluster-root.js';
import { evaluateRules, RULES } from './rules.js';
import { scanRepo } from './scanner.js';

const ITERATIONS = 20;
const TOUCH_FILE = path.join(KLUSTER_ROOT, 'application/api/src/config.ts');
const MARKER = '// align-probe-rescan marker\n';

function main(): void {
  const original = fs.readFileSync(TOUCH_FILE, 'utf8');
  const scanTimes: number[] = [];
  const ruleTimes: number[] = [];
  const heapAfter: number[] = [];

  try {
    for (let i = 0; i < ITERATIONS; i += 1) {
      // Alternate appending/removing a line so content genuinely changes every iteration.
      fs.writeFileSync(TOUCH_FILE, i % 2 === 0 ? original + MARKER : original);

      const t0 = performance.now();
      const { graph } = scanRepo(KLUSTER_ROOT, SCAN_ROOTS);
      const t1 = performance.now();
      evaluateRules(graph, RULES);
      const t2 = performance.now();

      scanTimes.push(t1 - t0);
      ruleTimes.push(t2 - t1);
      heapAfter.push(process.memoryUsage().heapUsed / (1024 * 1024));
    }
  } finally {
    fs.writeFileSync(TOUCH_FILE, original); // always restore the copy's file
  }

  const sorted = [...scanTimes].sort((a, b) => a - b);
  const mean = scanTimes.reduce((a, b) => a + b, 0) / scanTimes.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const ruleMean = ruleTimes.reduce((a, b) => a + b, 0) / ruleTimes.length;

  console.log(JSON.stringify({
    iterations: ITERATIONS,
    scanMs: {
      mean: Math.round(mean),
      p95: Math.round(p95),
      min: Math.round(min),
      max: Math.round(max),
      all: scanTimes.map((t) => Math.round(t)),
    },
    ruleEvalMsMean: Math.round(ruleMean * 10) / 10,
    heapAfterMb: { first: Math.round(heapAfter[0] ?? 0), last: Math.round(heapAfter[heapAfter.length - 1] ?? 0) },
    rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
  }, null, 2));
}

main();
