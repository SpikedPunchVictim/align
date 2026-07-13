# @spikedpunch/align-plugin-typescript

The TypeScript/JavaScript language plugin for
[align](https://github.com/SpikedPunchVictim/align) — an architecture-conformance verification
oracle for humans and LLM coding agents.

Implements [`@spikedpunch/align-core`](https://www.npmjs.com/package/@spikedpunch/align-core)'s
`LanguagePlugin`/`Scanner` and `ManifestScanner` interfaces:

- a scan-and-discard dependency-graph builder over the TypeScript compiler API,
- nearest-`tsconfig` resolution,
- a pnpm-workspace-name resolver with **realpath** classification of inter-package edges (path
  substring matching silently misclassifies workspace-symlinked edges as external), and
- the `package.json`/`pnpm-lock.yaml` manifest scanner behind align's security gate.

Depends on `typescript` and `yaml`. `@spikedpunch/align-core` never imports this package —
dependency direction is `core ← plugin`, enforced by align's own dogfooded rules.

Most users want the `align` CLI — see
[`@spikedpunch/align-cli`](https://www.npmjs.com/package/@spikedpunch/align-cli). Import this
package directly only to compose a custom align host.

## License

MIT
