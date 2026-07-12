#!/usr/bin/env node
import { Command } from 'commander';
import { runCheck } from './commands/check.js';
import { runInit } from './commands/init.js';
import { baselineAccept, baselinePrune, baselineShow } from './commands/baseline.js';
import { buildExplainPayload } from './commands/explain.js';
import { runDoctor } from './commands/doctor.js';
import { runBuild, DEFAULT_DOC_PATH } from './commands/build.js';
import { startMcpServer } from './mcp/server.js';

const program = new Command();
program.name('align').description('Architecture-conformance verification oracle for LLM coding agents.');

program
  .command('init')
  .description('Detect components, write a starter align.config.ts, and seed the baseline.')
  .option('--accept-existing', 'seed the baseline non-interactively with all pre-existing violations', false)
  .action(async (opts: { acceptExisting: boolean }) => {
    const code = await runInit(process.cwd(), { acceptExisting: opts.acceptExisting });
    process.exitCode = code;
  });

program
  .command('check')
  .description('Run architecture rules against a fresh scan of the repo. Exit 0 iff green.')
  .option('--json', 'print the structured check payload as JSON', false)
  .option('--frozen-rules', 'also fail if a doc-built ruleset has drifted from its lockfile (ADR 011)', false)
  .action(async (opts: { json: boolean; frozenRules: boolean }) => {
    const code = await runCheck(process.cwd(), { json: opts.json, frozenRules: opts.frozenRules });
    process.exitCode = code;
  });

const baseline = program.command('baseline').description('Manage the violation baseline (tolerated debt).');

baseline
  .command('accept')
  .description('Accept current violations into the baseline (optionally scoped to one rule).')
  .option('--rule <ruleId>', 'only accept violations of this rule')
  .action(async (opts: { rule?: string }) => {
    process.exitCode = await baselineAccept(process.cwd(), opts.rule);
  });

baseline
  .command('prune')
  .description('Remove baseline entries for violations that no longer exist; report moved entries.')
  .action(async () => {
    process.exitCode = await baselinePrune(process.cwd());
  });

baseline
  .command('show')
  .description('List baselined violations (optionally scoped to one rule).')
  .option('--rule <ruleId>', 'only show violations of this rule')
  .action(async (opts: { rule?: string }) => {
    process.exitCode = await baselineShow(process.cwd(), opts.rule);
  });

program
  .command('explain <ruleId>')
  .description('Explain one architecture rule: its kind, rationale, and constrained components.')
  .action(async (ruleId: string) => {
    const payload = await buildExplainPayload(process.cwd(), ruleId);
    if (payload === undefined) {
      console.error(`Unknown rule id '${ruleId}'.`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(payload, null, 2));
  });

program
  .command('doctor')
  .description(
    'Read-only advisory survey: dead tsconfig path aliases, uncertainty breakdown, unmapped ' +
      'files, workspace-orphaned packages, empty components. Never fails — exit code is always 0.',
  )
  .option('--json', 'print structured advisories + capped per-specifier uncertainty detail as JSON', false)
  .action(async (opts: { json: boolean }) => {
    process.exitCode = await runDoctor(process.cwd(), { json: opts.json });
  });

program
  .command('build')
  .description(
    'Compile a markdown architecture doc into the ruleset (ADR 011): fenced ```align blocks + ' +
      'structured `- **Rule**:` bullets, zero LLM. Default is dry-run (prints the proposal diff + ' +
      'impact delta, writes nothing).',
  )
  .option('--doc <path>', 'doc to build (default docs/ARCHITECTURE-RULES.md)', DEFAULT_DOC_PATH)
  .option('--apply', 'write .align/generated-rules.json, rules.lock.json, and the audit report', false)
  .option('--if-changed', 'exit 0 immediately if the doc is unchanged since the last build', false)
  .option('--verify', 'exit red if the doc or generated-rules.json has drifted from the lockfile (ADR 011)', false)
  .option('--accept-new-into-baseline', 'seed any new violations the proposal adds into the baseline', false)
  .action(async (opts: { doc: string; apply: boolean; ifChanged: boolean; verify: boolean; acceptNewIntoBaseline: boolean }) => {
    const code = await runBuild(process.cwd(), {
      doc: opts.doc,
      apply: opts.apply,
      ifChanged: opts.ifChanged,
      verify: opts.verify,
      acceptNewIntoBaseline: opts.acceptNewIntoBaseline,
    });
    process.exitCode = code;
  });

program
  .command('mcp')
  .description('Start the align MCP server (stdio) exposing align_check / align_violations / align_explain_rule.')
  .action(async () => {
    await startMcpServer(process.cwd());
  });

await program.parseAsync(process.argv);
