import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSessionId } from './session.js';

/** The CLI's own version, read at runtime from this package's `package.json` — the true single
 * source of truth (`program.ts`'s `.version(...)` and `align docs`' header import this). The release
 * version-bump only ever touches `package.json`; reading it here means the version can never drift
 * from what's published, the way a hardcoded literal silently did. This module resolves to
 * `dist/telemetry/process-context.js` at runtime (and `src/telemetry/...` under tests) — both two
 * directories below the package root — and `package.json` always ships in the npm tarball. */
function readAlignVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const ALIGN_VERSION = readAlignVersion();

/** Computed once, at module load — ESM caches a module instance per process, so every command
 * within one `align` invocation that imports this sees the identical id (IMPLEMENTATION_PLAN.md:
 * "sessionId injected, CLI generates one per process"). Never regenerated mid-process, never read
 * from anywhere network-facing (`node:crypto`'s local `randomUUID`, `session.ts`). */
export const TELEMETRY_SESSION_ID = generateSessionId();
