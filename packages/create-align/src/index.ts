#!/usr/bin/env node
import { parseCreateAlignArgs } from './cli.js';
import { createNodeEffects } from './nodeEffects.js';
import { runCreateAlign } from './run.js';

const parsed = parseCreateAlignArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`create-align: ${parsed.error}`);
  process.exit(1);
}

const effects = createNodeEffects(process.cwd());
const result = await runCreateAlign(effects, {
  ...(parsed.args.pm !== undefined ? { pmOverride: parsed.args.pm } : {}),
  initArgs: parsed.args.passthrough,
});

process.exit(result.status === 'no-package-json' ? 1 : result.exitCode);
