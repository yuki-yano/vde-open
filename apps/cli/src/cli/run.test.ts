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
  });
  return { exitCode, stdout, stderr };
}

describe('CLI-002 両名でhelp/version（CLI本体）', () => {
  it('--versionはpackage.jsonのversionだけをstdoutへ出す', async () => {
    expect(await run(['--version'])).toEqual({
      exitCode: 0,
      stdout: `${packageJson.version}\n`,
      stderr: '',
    });
  });

  it('--helpは固定の表示名とvoの案内を出す', async () => {
    const result = await run(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: vde-open');
    expect(result.stdout).toContain('`vo`は`vde-open`と同じコマンドです。');
  });

  it('未知のoptionはexit 2で、stdoutへ何も出さない', async () => {
    const result = await run(['--target', 'x']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--target');
  });
});
