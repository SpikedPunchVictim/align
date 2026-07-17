import { Command } from 'commander';
import { runCheck } from './commands/check.js';
import { runExportIr } from './commands/export-ir.js';
import { runInit } from './commands/init.js';
import { baselineAccept, baselinePrune, baselineShow } from './commands/baseline.js';
import { buildExplainPayload } from './commands/explain.js';
import { runDoctor } from './commands/doctor.js';
import { runBuild, DEFAULT_DOC_PATH } from './commands/build.js';
import { runAgentCommand } from './commands/agent.js';
import { runSkill, type SkillTopic } from './commands/skill.js';
import { runDocs } from './commands/docs.js';
import { runTelemetryReport, DEFAULT_TELEMETRY_FILE } from './commands/telemetry.js';
import { startMcpServer } from './mcp/server.js';
import { ALIGN_VERSION, resolveTelemetryPreConfig } from './telemetry/index.js';

/** `--telemetry` / `--no-telemetry` (IMPLEMENTATION_PLAN.md's telemetry spec) share commander's
 * negatable-option pairing on every command that can emit telemetry: neither flag passed leaves
 * `opts.telemetry` `undefined` ("defer to `ALIGN_TELEMETRY`/`align.config.ts`"), `--telemetry`
 * forces `true`, `--no-telemetry` forces `false` and overrides env/config (verified directly
 * against commander's own option-merging behavior, not assumed). */
function addTelemetryOptions(cmd: Command): Command {
  return cmd
    .option('--telemetry', 'force-enable the local-only telemetry log for this run (see also ALIGN_TELEMETRY=1 / align.config.ts telemetry:true)')
    .option('--no-telemetry', 'disable telemetry for this run — overrides ALIGN_TELEMETRY / align.config.ts telemetry:true');
}

/**
 * Builds the `align` commander program without invoking `parseAsync` — split out of `index.ts`
 * (Stage 5, IMPLEMENTATION_PLAN.md "Elevated first items") so the CLI command inventory is a
 * live, introspectable object (`program.commands`) instead of a hand-maintained list: `align
 * skill`'s generated CLI-command-inventory section (`packages/cli/src/skill/cli-inventory.ts`)
 * calls this function and walks the real `Command` tree, so it cannot list a command that doesn't
 * exist or omit one that does. `index.ts` is now just `buildProgram().parseAsync(process.argv)`.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('align')
    .description('Architecture-conformance verification oracle for LLM coding agents.')
    .version(ALIGN_VERSION, '-v, --version', 'print the align CLI version');

  program
    .command('init')
    .description('Detect components, write a starter align.config.ts, and seed the baseline.')
    .option('--accept-existing', 'seed the baseline non-interactively with all pre-existing violations', false)
    .option(
      '--greenfield',
      "force every detected component to empty: 'until-populated' regardless of today's file count (architecture-first authoring)",
      false,
    )
    .option(
      '-y, --yes',
      'answer yes without prompting where safe (the npm-script offer only — baseline seeding of ' +
        'pre-existing violations still requires --accept-existing; consent to tolerate existing debt is never silent)',
      false,
    )
    .option('--no-scripts', 'skip offering to add an "align": "align check" script to package.json')
    .action(async (opts: { acceptExisting: boolean; greenfield: boolean; yes: boolean; scripts: boolean }) => {
      const code = await runInit(process.cwd(), {
        acceptExisting: opts.acceptExisting,
        greenfield: opts.greenfield,
        yes: opts.yes,
        noScripts: !opts.scripts,
      });
      process.exitCode = code;
    });

  addTelemetryOptions(
    program
      .command('check')
      .description('Run architecture rules against a fresh scan of the repo. Exit 0 iff green.')
      .option('--json', 'print the structured check payload as JSON', false)
      .option('--frozen-rules', 'also fail if a doc-built ruleset has drifted from its lockfile (ADR 011)', false)
      .option(
        '--untrusted',
        'never execute align.config.ts (or any hostRules predicate) — load the ruleset from ' +
          '.align/ruleset-ir.json instead (ADR 014). Refuses if that file is missing or contains a ' +
          'custom.host rule; run `align export-ir` in a trusted checkout first.',
        false,
      )
      .option('--ir-only', 'alias for --untrusted', false)
      .option('--ir <path>', 'override the .align/ruleset-ir.json path --untrusted/--ir-only reads from'),
  ).action(
    async (opts: { json: boolean; frozenRules: boolean; untrusted: boolean; irOnly: boolean; ir?: string; telemetry?: boolean }) => {
      const telemetryPreConfig = resolveTelemetryPreConfig({ telemetry: opts.telemetry });
      const code = await runCheck(process.cwd(), {
        json: opts.json,
        frozenRules: opts.frozenRules,
        untrusted: opts.untrusted || opts.irOnly,
        ...(opts.ir !== undefined ? { ir: opts.ir } : {}),
        ...(telemetryPreConfig !== undefined ? { telemetryPreConfig } : {}),
      });
      process.exitCode = code;
    },
  );

  program
    .command('export-ir')
    .description(
      'Run once in a trusted context: import align.config.ts and write the effective ruleset ' +
        '(components + rules, no functions) as portable JSON to .align/ruleset-ir.json — the data ' +
        'source `align check --untrusted` reads instead of executing align.config.ts (ADR 014).',
    )
    .option('--out <path>', 'override the default .align/ruleset-ir.json output path')
    .action(async (opts: { out?: string }) => {
      const code = await runExportIr(process.cwd(), opts.out !== undefined ? { out: opts.out } : {});
      process.exitCode = code;
    });

  const baseline = program.command('baseline').description('Manage the violation baseline (tolerated debt).');

  addTelemetryOptions(
    baseline
      .command('accept')
      .description('Accept current violations into the baseline (optionally scoped to one rule).')
      .option('--rule <ruleId>', 'only accept violations of this rule'),
  ).action(async (opts: { rule?: string; telemetry?: boolean }) => {
    const telemetryPreConfig = resolveTelemetryPreConfig({ telemetry: opts.telemetry });
    process.exitCode = await baselineAccept(process.cwd(), opts.rule, telemetryPreConfig);
  });

  addTelemetryOptions(
    baseline.command('prune').description('Remove baseline entries for violations that no longer exist; report moved entries.'),
  ).action(async (opts: { telemetry?: boolean }) => {
    const telemetryPreConfig = resolveTelemetryPreConfig({ telemetry: opts.telemetry });
    process.exitCode = await baselinePrune(process.cwd(), telemetryPreConfig);
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
        'files, workspace-orphaned packages, empty components, stale installed skill snapshot ' +
        '(`align skill --install`). Never fails — exit code is always 0.',
    )
    .option('--json', 'print structured advisories + capped per-specifier uncertainty detail as JSON', false)
    .action(async (opts: { json: boolean }) => {
      process.exitCode = await runDoctor(process.cwd(), { json: opts.json });
    });

  addTelemetryOptions(
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
      .option('--accept-new-into-baseline', 'seed any new violations the proposal adds into the baseline', false),
  ).action(
    async (opts: { doc: string; apply: boolean; ifChanged: boolean; verify: boolean; acceptNewIntoBaseline: boolean; telemetry?: boolean }) => {
      const telemetryPreConfig = resolveTelemetryPreConfig({ telemetry: opts.telemetry });
      const code = await runBuild(process.cwd(), {
        doc: opts.doc,
        apply: opts.apply,
        ifChanged: opts.ifChanged,
        verify: opts.verify,
        acceptNewIntoBaseline: opts.acceptNewIntoBaseline,
        ...(telemetryPreConfig !== undefined ? { telemetryPreConfig } : {}),
      });
      process.exitCode = code;
    },
  );

  const agent = program.command('agent').description('Built-in BYOK LLM fix loop (Stage 4, ADR 010). Requires ANTHROPIC_API_KEY.');

  addTelemetryOptions(
    agent
      .command('run')
      .description(
        'DISCOVER -> GROUP -> PLAN+FIX -> APPLY -> VERIFY -> REPAIR -> ESCALATE -> DONE -> TERMINAL MERGE. ' +
          'Refuses a dirty worktree; every apply is a commit on a fresh align/fixes-<date> branch; never ' +
          'touches align.config.ts or .align/**.',
      )
      .option('--max-attempts <n>', 'max REPAIR attempts per file group', (v) => Number.parseInt(v, 10), 3)
      .option('--pr', 'push the work branch and open a draft PR (default)', true)
      .option('--auto-merge', 'fast-forward merge into the base branch and delete the work branch instead of opening a PR', false)
      .option('--allow-untested', 'allow PLAN+FIX on files with zero detected test coverage (default: refuse)', false)
      .option('--allow-symbol-removals', 'allow a fix that deletes an exported symbol to commit (default: escalate)', false)
      .option('--model <id>', 'override the FixProvider model id (default: config/env ALIGN_AGENT_MODEL, else claude-sonnet-5)')
      .option('--dry-run', 'DISCOVER+GROUP+PLAN only — print proposed edits without applying or committing', false),
  ).action(
    async (opts: {
      maxAttempts: number;
      pr: boolean;
      autoMerge: boolean;
      allowUntested: boolean;
      allowSymbolRemovals: boolean;
      model?: string;
      dryRun: boolean;
      telemetry?: boolean;
    }) => {
      const telemetryPreConfig = resolveTelemetryPreConfig({ telemetry: opts.telemetry });
      const code = await runAgentCommand(process.cwd(), {
        maxAttempts: opts.maxAttempts,
        pr: opts.pr,
        autoMerge: opts.autoMerge,
        allowUntested: opts.allowUntested,
        allowSymbolRemovals: opts.allowSymbolRemovals,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        dryRun: opts.dryRun,
        ...(telemetryPreConfig !== undefined ? { telemetryPreConfig } : {}),
      });
      process.exitCode = code;
    },
  );

  program
    .command('mcp')
    .description('Start the align MCP server (stdio) exposing align_check / align_violations / align_explain_rule.')
    .action(async () => {
      await startMcpServer(process.cwd());
    });

  program
    .command('skill')
    .description(
      'Print the LLM-facing align authoring/fixing guide (rule kinds, DSL verbs, bullet grammar, ' +
        'gates, and CLI commands generated live from the installed binary — never hand-written prose ' +
        'that can drift). --install writes .claude/skills/align/SKILL.md into this repo, stamped with ' +
        'the installing version (`align doctor` flags it once the snapshot goes stale).',
    )
    .option('--topic <topic>', 'authoring | fixing | all', 'all')
    .option('--install', 'write .claude/skills/align/SKILL.md (idempotent, delimited block)', false)
    .action(async (opts: { topic: string; install: boolean }) => {
      const topic = opts.topic as SkillTopic;
      if (topic !== 'authoring' && topic !== 'fixing' && topic !== 'all') {
        console.error(`Invalid --topic '${opts.topic}' — expected authoring | fixing | all.`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runSkill(process.cwd(), { topic, install: opts.install }, program);
    });

  program
    .command('docs [topic]')
    .description(
      "Print align's docs for THIS installed version. `align docs` lists topics; `align docs " +
        '<topic>` prints one (e.g. config, selectors, baseline, greenfield, security, untrusted, ' +
        'agent, ci, trust). Conceptual topics are version-matched prose bundled in the package; ' +
        'rule/verb/gate/command topics are generated live from the binary. For the full LLM ' +
        'authoring/fix-loop guide, see `align skill`.',
    )
    .action((topic: string | undefined) => {
      process.exitCode = runDocs(program, topic !== undefined ? { topic } : {});
    });

  program
    .command('telemetry')
    .description(
      'Summarize .align/telemetry.jsonl (opt-in, local-only — see ALIGN_TELEMETRY/--telemetry): check-latency ' +
        'percentiles, top-firing rules, time-to-green per rule, dead rules, baseline-vs-fix ratio, and ' +
        'friction ranking by error kind. The report the coordinator/user reads after a dogfood session.',
    )
    .option('--file <path>', `JSONL file to read (default ${DEFAULT_TELEMETRY_FILE})`)
    .option('--json', 'print the structured summary as JSON', false)
    .action(async (opts: { file?: string; json: boolean }) => {
      process.exitCode = await runTelemetryReport(process.cwd(), { json: opts.json, ...(opts.file !== undefined ? { file: opts.file } : {}) });
    });

  return program;
}
