import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTsconfig(dir: string, content: unknown): void {
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(content), 'utf8');
}

describe('align doctor', () => {
  it('always exits 0, even with dead aliases, unmapped files, and orphaned packages present', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), `export const x = 1;\n`, 'utf8');
    // A file outside the 'app' component's glob — surfaces as unmapped.
    fs.writeFileSync(path.join(tmpDir, 'other.ts'), `export const y = 1;\n`, 'utf8');
    writeTsconfig(tmpDir, {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        baseUrl: '.',
        paths: { '@dead/*': ['./nowhere/*'] },
      },
    });
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@spikedpunch/align-core/dsl';\nexport default defineProject({ components: { app: 'src/**' } });\n`,
      'utf8',
    );
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

    const code = await runDoctor(tmpDir);
    expect(code).toBe(0);
  });

  it('exits 0 and reports a config-error advisory when align.config.ts is missing, instead of throwing', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-test-'));
    const code = await runDoctor(tmpDir);
    expect(code).toBe(0);
  });

  it('reports a dead-alias advisory for a tsconfig paths entry with no matching target', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-test-'));
    writeTsconfig(tmpDir, {
      compilerOptions: { baseUrl: '.', paths: { '@dead/*': ['./nowhere/*'] } },
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runDoctor(tmpDir);
    } finally {
      console.log = originalLog;
    }
    expect(logs.join('\n')).toContain('dead-alias');
    expect(logs.join('\n')).toContain('@dead/*');
  });

  it('--json emits structured advisories plus capped per-specifier uncertainty detail (carried Stage 2 DX item)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    // A non-literal dynamic import specifier is genuine graph uncertainty (ADR 004) — gives the
    // JSON payload a real per-specifier entry to assert on, not just an empty array.
    fs.writeFileSync(
      path.join(tmpDir, 'src/index.ts'),
      `export async function load(name: string) {\n  return import(\`./modules/\${name}.js\`);\n}\n`,
      'utf8',
    );
    writeTsconfig(tmpDir, { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } });
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@spikedpunch/align-core/dsl';\nexport default defineProject({ components: { app: 'src/**' } });\n`,
      'utf8',
    );
    // Resolve `@spikedpunch/align-core/dsl` so align.config.ts's own import doesn't add unrelated
    // 'unresolvable-specifier' noise to this test's uncertainty assertions.
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runDoctor(tmpDir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(code).toBe(0);

    const payload = JSON.parse(logs.join('')) as {
      advisories: { kind: string; message: string }[];
      uncertainty: { total: number; detail: { file: string; specifier: string; line: number; reason: string }[] };
    };
    expect(Array.isArray(payload.advisories)).toBe(true);
    expect(payload.uncertainty.total).toBeGreaterThanOrEqual(1);
    expect(payload.uncertainty.detail.length).toBeLessThanOrEqual(50);
    expect(payload.uncertainty.detail[0]).toMatchObject({ reason: 'non-literal-dynamic-specifier' });
    expect(payload.uncertainty.detail[0]?.file).toBeDefined();
    expect(payload.uncertainty.detail[0]?.line).toBeDefined();
  });

  // Stage 5 polish, evidence: RULESET_REPORT.md (kluster ruleset exercise) logged 47
  // orphaned-package advisories and 34 dead-alias hits as human-output DX friction.
  describe('human output caps advisories per kind (Stage 5 polish)', () => {
    it('shows the first 10 per kind + "and M more (use --json for all)"; --json stays complete', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-test-'));
      fs.writeFileSync(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "covered/*"\n', 'utf8');

      // 12 packages on disk, none covered by the lone `covered/*` glob above — 12
      // workspace-orphaned-package advisories, well past the 10-per-kind human display cap.
      const ORPHAN_COUNT = 12;
      for (let i = 0; i < ORPHAN_COUNT; i += 1) {
        const dir = path.join(tmpDir, 'extra', `pkg-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@fixture/pkg-${i}` }), 'utf8');
      }

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        await runDoctor(tmpDir);
      } finally {
        console.log = originalLog;
      }
      const output = logs.join('\n');
      const orphanLines = logs.filter((l) => l.trim().startsWith('- extra/pkg-'));
      expect(orphanLines).toHaveLength(10);
      expect(output).toContain(`workspace-orphaned-package (${ORPHAN_COUNT}):`);
      expect(output).toContain('... and 2 more (use --json for all)');

      const jsonLogs: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        jsonLogs.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await runDoctor(tmpDir, { json: true });
      } finally {
        process.stdout.write = originalWrite;
      }
      const payload = JSON.parse(jsonLogs.join('')) as { advisories: { kind: string }[] };
      expect(payload.advisories.filter((a) => a.kind === 'workspace-orphaned-package')).toHaveLength(ORPHAN_COUNT);
    });

    it('prints no "and M more" line when a kind has 10 or fewer advisories', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-test-'));
      fs.writeFileSync(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "covered/*"\n', 'utf8');
      const dir = path.join(tmpDir, 'extra', 'pkg-0');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@fixture/pkg-0' }), 'utf8');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        await runDoctor(tmpDir);
      } finally {
        console.log = originalLog;
      }
      expect(logs.join('\n')).not.toContain('more (use --json for all)');
    });
  });
});
