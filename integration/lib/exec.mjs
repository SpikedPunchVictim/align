// Process execution for the harness. One rule, no exceptions: every command the harness runs is
// captured — stdout, stderr, exit code, duration — never streamed straight to the terminal and
// discarded, because the whole design (ADR 025 §2) is that a failure must be diagnosable from the
// captured artifacts alone, without re-running.
import { spawnSync } from 'node:child_process';

const TEN_MB = 10 * 1024 * 1024;

/**
 * Runs `command` with `args` in `cwd` and returns the full captured result. Never throws on a
 * non-zero exit — a non-zero exit is frequently the EXPECTED outcome under test (a refusal, a red
 * verdict), so "the process exited non-zero" must be a data point the caller's declarative
 * `expect` evaluates, not a control-flow exception the caller has to catch everywhere.
 */
export function run(command, args, options = {}) {
  const start = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: TEN_MB,
    timeout: options.timeoutMs ?? 5 * 60 * 1000,
  });
  const durationMs = Date.now() - start;
  if (result.error) {
    // A launch failure (ENOENT, timeout, signal) is NOT a normal non-zero exit — the process never
    // ran to completion, so there is nothing for a declarative `expect` to have meant. This is a
    // harness/environment bug, not a scenario outcome: fail loudly rather than reporting a
    // misleading exit code.
    throw new Error(
      `failed to run \`${command} ${args.join(' ')}\` in ${options.cwd ?? process.cwd()}: ${result.error.message}`,
    );
  }
  return {
    command: `${command} ${args.join(' ')}`,
    cwd: options.cwd,
    exitCode: result.status ?? (result.signal ? 128 : 0),
    signal: result.signal ?? undefined,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs,
  };
}

/** Runs an `align` CLI invocation against the build installed in `workingDir/node_modules`, by
 * absolute path to its entry point — never relies on `$PATH`/`node_modules/.bin` symlink
 * resolution, so the same invocation works identically on macOS and inside the Docker image. */
export function runAlign(workingDir, argsString) {
  const entry = `${workingDir}/node_modules/@spikedpunch/align-cli/dist/index.js`;
  const args = splitArgs(argsString);
  return run(process.execPath, [entry, ...args], { cwd: workingDir });
}

/** Minimal shell-like argv splitter for scenario `run:` strings — supports single/double-quoted
 * segments (needed for `--rule 'arch.no-dependency:x->y'`-shaped args) without pulling in a shell
 * or a parsing dependency. Not a general shell grammar: no globbing, no pipes, no `$VAR` expansion
 * — scenario steps are trusted, hand-authored data, not untrusted shell input. */
export function splitArgs(argsString) {
  const out = [];
  let cur = '';
  let quote = undefined;
  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ') {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
