import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dryRunBuild, runBuild, verifyFrozenRules, writeBuildArtifacts } from '../src/commands/build.js';
import { runCheck } from '../src/commands/check.js';
import { generatedRulesPath, rulesLockPath, lastBuildReportPath } from '../src/align-dir.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-build-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

const DOC = 'docs/ARCHITECTURE-RULES.md';

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('align build — dry run', () => {
  it('proposes one rule per bullet/block and writes nothing', async () => {
    tmpDir = copyFixture('build-app');
    const result = await dryRunBuild(tmpDir, DOC);
    expect(result.proposal.rules.map((r) => r.id).sort()).toEqual(['arch.no-cycles:repo', 'arch.no-dependency:api->ui']);
    expect(result.proposal.flagged).toHaveLength(0);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(false);
    expect(fs.existsSync(rulesLockPath(tmpDir))).toBe(false);
  });

  it('`align build` (no --apply) writes nothing on disk', async () => {
    tmpDir = copyFixture('build-app');
    const code = await runBuild(tmpDir, { apply: false, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(false);
  });
});

// R3 (greenfield mode, IMPLEMENTATION_PLAN.md Design Reserve): `align build` used to throw the
// same `ComponentValidationError` `align check` catches cleanly, but unhandled — a raw Node stack
// trace (GREENFIELD_TRIAD_REPORT.md §3). `runBuild` now catches it the same way `align check`
// does. These tests assert `runBuild` RESOLVES with a clean exit code either way — if the fix
// regressed, the promise would reject and vitest would report an uncaught exception instead of a
// normal test failure, which is exactly the "raw stack trace" symptom being guarded against.
describe('align build — graceful-fail parity with `align check` on an empty component (R3)', () => {
  function addGhostComponent(dir: string, empty?: "'until-populated'" | "'allow'"): void {
    const suffix = empty === undefined ? '' : `, empty: ${empty}`;
    fs.writeFileSync(
      path.join(dir, 'align.config.ts'),
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
        `export default defineProject({\n` +
        `  components: { api: 'src/api/**', ui: 'src/ui/**', ghost: { pattern: 'src/ghost/**'${suffix} } },\n` +
        `});\n`,
      'utf8',
    );
  }

  it("empty: 'fail' (default): a zero-file component produces a clean error — same condition align check already handles, no raw stack trace", async () => {
    tmpDir = copyFixture('build-app');
    addGhostComponent(tmpDir);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = ((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    }) as typeof console.error;
    let code: number;
    try {
      code = await runBuild(tmpDir, { apply: false, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    } finally {
      console.error = originalError;
    }
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain("'ghost'");
    expect(errors.join('\n')).toContain('matches zero files');
    // No stack-trace leakage: align's own clean error message, not Node's default uncaught-error
    // rendering (which would include "at " stack frames from build.js/scanner.js internals).
    expect(errors.join('\n')).not.toContain('    at ');
  });

  it("empty: 'until-populated': the same zero-file component builds successfully — no crash, no error", async () => {
    tmpDir = copyFixture('build-app');
    addGhostComponent(tmpDir, "'until-populated'");
    const result = await dryRunBuild(tmpDir, DOC);
    expect(result.proposal.flagged).toHaveLength(0);
    const code = await runBuild(tmpDir, { apply: false, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);
  });

  it("empty: 'allow': the same zero-file component builds successfully — no crash, no error", async () => {
    tmpDir = copyFixture('build-app');
    addGhostComponent(tmpDir, "'allow'");
    const code = await runBuild(tmpDir, { apply: false, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);
  });
});

describe('align build --apply', () => {
  it('writes generated-rules.json, rules.lock.json, and the audit report; check stays green', async () => {
    tmpDir = copyFixture('build-app');
    const code = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(true);
    expect(fs.existsSync(rulesLockPath(tmpDir))).toBe(true);
    expect(fs.existsSync(lastBuildReportPath(tmpDir))).toBe(true);

    const report = fs.readFileSync(lastBuildReportPath(tmpDir), 'utf8');
    expect(report).toContain('arch.no-dependency:api->ui');
    expect(report).toContain('must not depend on');

    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });

  it('writes an idempotent note into align.config.ts about the generated-rules auto-merge (carried Stage 3 affordance)', async () => {
    tmpDir = copyFixture('build-app');
    const configPath = path.join(tmpDir, 'align.config.ts');
    const before = fs.readFileSync(configPath, 'utf8');

    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    expect(afterFirst).toContain('align:generated-rules-note:start');
    expect(afterFirst).toContain('merged into');
    expect(afterFirst.length).toBeGreaterThan(before.length);

    // Re-running --apply must not duplicate the block.
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    const afterSecond = fs.readFileSync(configPath, 'utf8');
    expect(afterSecond.split('align:generated-rules-note:start')).toHaveLength(2);
  });

  it('surfaces "+N rules from <doc> (built <date>)" in `align check` output once rules are generated', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await runCheck(tmpDir, { json: false });
    } finally {
      console.log = originalLog;
    }
    expect(logs.some((l) => /\+2 rules from docs\/ARCHITECTURE-RULES\.md \(built \d{4}-\d{2}-\d{2}\)/.test(l))).toBe(true);

    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCheck(tmpDir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(stdoutChunks.join('')) as { generatedRules?: { count: number; doc: string } };
    expect(payload.generatedRules).toEqual({ count: 2, doc: 'docs/ARCHITECTURE-RULES.md', builtAt: expect.any(String) });
  });

  it('a violation of a generated rule quotes the doc file:lines in the violation message', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });

    // Seed a forbidden import — api now depends on ui.
    fs.writeFileSync(
      path.join(tmpDir, 'src/api/other.ts'),
      `import { render } from '../ui/component.js';\n\nexport function handleOther(): string {\n  return render();\n}\n`,
      'utf8',
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    let code: number;
    try {
      code = await runCheck(tmpDir, { json: false });
    } finally {
      console.log = originalLog;
    }
    expect(code).toBe(1);
    // The human renderer word-wraps long messages across lines; normalize whitespace so the
    // assertion checks message content, not where the wrap happened to fall.
    const output = logs.join(' ').replace(/\s+/g, ' ');
    expect(output).toContain(`Enforced by ${DOC}:5:`);
    expect(output).toContain('`api` must not depend on `ui`.');
  });

  it('build without --apply never writes even when a previous --apply exists', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    const before = fs.readFileSync(generatedRulesPath(tmpDir), 'utf8');

    fs.writeFileSync(
      path.join(tmpDir, DOC),
      fs.readFileSync(path.join(tmpDir, DOC), 'utf8').replace('API Isolation', 'API Isolation (reworded)'),
      'utf8',
    );
    await runBuild(tmpDir, { apply: false, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(fs.readFileSync(generatedRulesPath(tmpDir), 'utf8')).toBe(before);
  });

  it('requires --accept-new-into-baseline when the proposal adds new violations', async () => {
    tmpDir = copyFixture('build-app');
    fs.writeFileSync(
      path.join(tmpDir, 'src/api/other.ts'),
      `import { render } from '../ui/component.js';\n\nexport function handleOther(): string {\n  return render();\n}\n`,
      'utf8',
    );
    const code = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false, nonInteractive: true });
    expect(code).toBe(1);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(false);

    const code2 = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: true, nonInteractive: true });
    expect(code2).toBe(0);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(true);
  });
});

describe('align build — diff minimization', () => {
  it('rewording one section changes only that section; other sections stay unchanged', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });

    // Reformat the fenced block's JSON (same parsed content, different bytes/quote text) — a
    // same-line edit, so it can't shift any other section's line numbers. The "API Isolation"
    // bullet is untouched and must come out byte-identical.
    const docText = fs.readFileSync(path.join(tmpDir, DOC), 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, DOC),
      docText.replace('{"kind":"arch.no-cycles","scope":"repo"}', '{"kind": "arch.no-cycles", "scope": "repo"}'),
      'utf8',
    );

    const result = await dryRunBuild(tmpDir, DOC);
    // Whitespace-only reformatting of the fenced block changes the captured `sourceQuote`
    // (provenance) but not the rule's structural fields (kind/scope) — this is a provenance-only
    // change (Stage 5 infra fix, `build/diff.ts`'s `RuleDiff.provenanceOnlyChanged`), not a
    // structural one. Zero rules land in `changed`; the other section is fully unaffected.
    expect(result.diff.changed).toHaveLength(0);
    expect(result.diff.provenanceOnlyChanged.map((c) => c.after.id)).toEqual(['arch.no-cycles:repo']);
    expect(result.diff.unchanged.map((r) => r.id)).toEqual(['arch.no-dependency:api->ui']);
  });

  it('an IR-identical re-proposal (no textual change) yields an empty diff', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });

    const result = await dryRunBuild(tmpDir, DOC);
    expect(result.diff.added).toHaveLength(0);
    expect(result.diff.removed).toHaveLength(0);
    expect(result.diff.changed).toHaveLength(0);
    expect(result.diff.unchanged).toHaveLength(2);
    expect(result.diff.provenanceOnlyChanged).toHaveLength(0);
  });

  it('writeBuildArtifacts reports provenance-only updates separately from structural changes in its message', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });

    const docText = fs.readFileSync(path.join(tmpDir, DOC), 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, DOC),
      docText.replace('{"kind":"arch.no-cycles","scope":"repo"}', '{"kind": "arch.no-cycles", "scope": "repo"}'),
      'utf8',
    );

    const result = await dryRunBuild(tmpDir, DOC);
    const applied = writeBuildArtifacts(tmpDir, result, { acceptNewIntoBaseline: false });
    expect(applied.ok).toBe(true);
    expect(applied.message).toContain('0 changed');
    expect(applied.message).toContain('1 unchanged (provenance-only updates)');
  });
});

describe('align build --if-changed', () => {
  it('exits fast when the doc is unchanged since the last build', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    const before = fs.readFileSync(lastBuildReportPath(tmpDir), 'utf8');

    const code = await runBuild(tmpDir, { apply: true, ifChanged: true, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);
    // Nothing rebuilt — the report file is untouched.
    expect(fs.readFileSync(lastBuildReportPath(tmpDir), 'utf8')).toBe(before);
  });

  it('proceeds normally once the doc has changed', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    fs.writeFileSync(
      path.join(tmpDir, DOC),
      fs.readFileSync(path.join(tmpDir, DOC), 'utf8').replace('## No Cycles', '## No Cycles (edited)'),
      'utf8',
    );
    const code = await runBuild(tmpDir, { apply: true, ifChanged: true, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);
  });
});

describe('align build --verify / align check --frozen-rules', () => {
  it('is red after a doc edit until the ruleset is rebuilt', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(verifyFrozenRules(tmpDir).ok).toBe(true);

    fs.writeFileSync(
      path.join(tmpDir, DOC),
      fs.readFileSync(path.join(tmpDir, DOC), 'utf8').replace('## No Cycles', '## No Cycles (edited)'),
      'utf8',
    );
    const drifted = verifyFrozenRules(tmpDir);
    expect(drifted.ok).toBe(false);
    expect(drifted.advisories.some((a) => a.kind === 'doc-drift')).toBe(true);

    const verifyCode = await runBuild(tmpDir, { apply: false, ifChanged: false, verify: true, acceptNewIntoBaseline: false });
    expect(verifyCode).toBe(1);

    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(verifyFrozenRules(tmpDir).ok).toBe(true);
    const rebuiltVerify = await runBuild(tmpDir, { apply: false, ifChanged: false, verify: true, acceptNewIntoBaseline: false });
    expect(rebuiltVerify).toBe(0);
  });

  it('flags divergence when generated-rules.json is hand-edited after --apply', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(verifyFrozenRules(tmpDir).ok).toBe(true);

    const generated = JSON.parse(fs.readFileSync(generatedRulesPath(tmpDir), 'utf8')) as { rules: unknown[] };
    generated.rules.pop();
    fs.writeFileSync(generatedRulesPath(tmpDir), JSON.stringify(generated, null, 2), 'utf8');

    const diverged = verifyFrozenRules(tmpDir);
    expect(diverged.ok).toBe(false);
    expect(diverged.advisories.some((a) => a.kind === 'divergence')).toBe(true);
  });

  it('`align check --frozen-rules` fails on drift and is a no-op before any build has run', async () => {
    tmpDir = copyFixture('build-app');
    expect(await runCheck(tmpDir, { json: false, frozenRules: true })).toBe(0); // no lockfile yet — no-op

    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(await runCheck(tmpDir, { json: false, frozenRules: true })).toBe(0);

    fs.writeFileSync(
      path.join(tmpDir, DOC),
      fs.readFileSync(path.join(tmpDir, DOC), 'utf8').replace('## No Cycles', '## No Cycles (edited)'),
      'utf8',
    );
    expect(await runCheck(tmpDir, { json: false, frozenRules: true })).toBe(1);
    expect(await runCheck(tmpDir, { json: false })).toBe(0); // plain check is unaffected by drift

    // The `verdict` field itself must flip to 'red' during drift, not just the exit code — a
    // false 'green' in the machine payload is exactly the false-green class the project treats as
    // severity-zero (ARCHITECTURE.md), and an agent reading --json alone must not be misled.
    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCheck(tmpDir, { json: true, frozenRules: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(logs.join('')) as { verdict: string; advisories: { kind: string }[] };
    expect(payload.verdict).toBe('red');
    expect(payload.advisories.some((a) => a.kind === 'doc-drift')).toBe(true);
  });
});

describe('writeBuildArtifacts (shared apply pipeline)', () => {
  it('refuses to write when new violations lack explicit consent', async () => {
    tmpDir = copyFixture('build-app');
    fs.writeFileSync(
      path.join(tmpDir, 'src/api/other.ts'),
      `import { render } from '../ui/component.js';\n\nexport function handleOther(): string {\n  return render();\n}\n`,
      'utf8',
    );
    const result = await dryRunBuild(tmpDir, DOC);
    expect(result.impact.addedNew.length).toBeGreaterThan(0);
    const applied = writeBuildArtifacts(tmpDir, result, { acceptNewIntoBaseline: false });
    expect(applied.ok).toBe(false);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(false);
  });
});
