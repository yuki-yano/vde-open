import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { runCli } from './run.ts';

async function run(argv: string[], home = '/nonexistent/vde-open-unit-test') {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd: process.cwd(),
    // Test only commands that do not connect to the daemon.
    environment: {
      env: { VDE_OPEN_HOME: home },
      platform: process.platform,
      homeDir: '/nonexistent',
      uid: null,
    },
    stdoutIsTty: false,
    stdin: { isPiped: false, read: () => Promise.resolve(Buffer.alloc(0)) },
  });
  return { exitCode, stdout, stderr };
}

describe('CLI-002 help/version under both names (CLI itself)', () => {
  it('--version writes only the package.json version to stdout', async () => {
    expect(await run(['--version'])).toEqual({
      exitCode: 0,
      stdout: `${packageJson.version}\n`,
      stderr: '',
    });
  });

  it('--help shows the fixed display name and the note about vo', async () => {
    const result = await run(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: vde-open');
    expect(result.stdout).toContain('`vo` is the same command as `vde-open`.');
  });

  it('an unknown option exits with 2 and writes nothing to stdout', async () => {
    const result = await run(['--target', 'x']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--target');
  });
});

describe('SYS-012 doctor --repair', () => {
  it('without --yes exits 2 and leaves a repairable state as it is', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vde-open-run-'));
    try {
      const store = await StateStore.open({ root: home, fs: nodeStoreFs });
      for (let commit = 0; commit < 2; commit += 1) {
        await store.transaction((tx) => {
          tx.state.catalogVersion += 1;
        });
      }
      await store.close();
      await writeFile(join(home, 'state.json'), 'broken');

      const result = await run(['doctor', '--repair', '--json'], home);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'E_CONFIRMATION_REQUIRED' },
      });
      expect(await readFile(join(home, 'state.json'), 'utf8')).toBe('broken');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
