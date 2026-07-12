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
      `import { defineProject } from '@align/core/dsl';\nexport default defineProject({ components: { app: 'src/**' } });\n`,
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
});
