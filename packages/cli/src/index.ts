#!/usr/bin/env node
import { Command } from 'commander';
import { runCheck } from './commands/check.js';
import { runInit } from './commands/init.js';
import { baselineAccept, baselinePrune, baselineShow } from './commands/baseline.js';
import { buildExplainPayload } from './commands/explain.js';
import { runDoctor } from './commands/doctor.js';
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
  .action(async (opts: { json: boolean }) => {
    const code = await runCheck(process.cwd(), { json: opts.json });
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
  .action(async () => {
    process.exitCode = await runDoctor(process.cwd());
  });

program
  .command('mcp')
  .description('Start the align MCP server (stdio) exposing align_check / align_violations / align_explain_rule.')
  .action(async () => {
    await startMcpServer(process.cwd());
  });

await program.parseAsync(process.argv);
