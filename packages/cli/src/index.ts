#!/usr/bin/env node
import { buildProgram } from './program.js';
import { AlignCoreMissingError } from './errors.js';

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // AlignCoreMissingError (config.ts's loadConfig, covering check/doctor/init) always renders as
  // a clean, actionable message here — never a raw ERR_MODULE_NOT_FOUND stack trace. Any other
  // error is rethrown unchanged (never swallowed) and surfaces with Node's normal uncaught-
  // exception reporting.
  if (err instanceof AlignCoreMissingError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
