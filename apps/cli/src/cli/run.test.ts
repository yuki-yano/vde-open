import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };
import { runCli } from './run.ts';

async function run(argv: string[]) {
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
    // Test only commands that do not connect to the daemon. The state root is not touched.
    environment: {
      env: { VDE_OPEN_HOME: '/nonexistent/vde-open-unit-test' },
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
