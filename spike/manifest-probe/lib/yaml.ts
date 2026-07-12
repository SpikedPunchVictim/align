// Throwaway spike glue: the `yaml` package is already installed transitively
// in the repo root's pnpm store (used by @align/plugin-typescript's own
// workspace.ts) but isn't a direct dependency of anything under spike/, so
// normal node resolution won't find it from here. Reach into the store by
// absolute path rather than adding a new dependency for a throwaway probe.
// Zero network calls: this only reads a package already on local disk.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const YAML_ENTRY =
  '/Users/spikedpunchvictim/projects/align/node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js';

interface YamlModule {
  parse(input: string): unknown;
}

const yamlModule = require(YAML_ENTRY) as YamlModule;

export function parseYaml(input: string): unknown {
  return yamlModule.parse(input);
}
