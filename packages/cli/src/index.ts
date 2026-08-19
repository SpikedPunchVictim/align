#!/usr/bin/env node
import { installWarningFilter } from './suppress-warnings.js';
import { buildProgram } from './program.js';
import { AlignCoreMissingError } from './errors.js';
import { commanderExitCode, installProcessContract } from './process-contract.js';

// Silence Node's benign MODULE_TYPELESS_PACKAGE_JSON note when loading align.config.ts from a target
// repo without "type":"module" — before any command (and its config load) runs.
installWarningFilter();
// The contract align owes the shell rather than the repository: a closing pipe is not a crash, and a
// usage error is not a red verdict (LEDGER D026).
installProcessContract(process.stdout, process.stderr);

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // Commander throws instead of exiting because `buildProgram` sets `exitOverride`, so this is where
  // `--help`, `--version` and every malformed command line land. It must come FIRST: a commander
  // error is never an `AlignCoreMissingError`, but ordering the checks by specificity is what keeps
  // that true if either type grows.
  const commanderCode = commanderExitCode(err);
  if (commanderCode !== undefined) {
    process.exitCode = commanderCode;
    // AlignCoreMissingError (config.ts's loadConfig, covering check/doctor/init) always renders as
    // a clean, actionable message here — never a raw ERR_MODULE_NOT_FOUND stack trace. Any other
    // error is rethrown unchanged (never swallowed) and surfaces with Node's normal uncaught-
    // exception reporting.
  } else if (err instanceof AlignCoreMissingError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
