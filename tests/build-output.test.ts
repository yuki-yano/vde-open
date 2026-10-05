import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withStagedOutputs } from '../scripts/build-output.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vde-open-build-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe('publishing build outputs', () => {
  it('keeps both previous outputs usable until the whole build succeeds', async () => {
    const cli = join(root, 'cli', 'dist');
    const web = join(root, 'web', 'dist');
    write(join(cli, 'cli.js'), 'old CLI');
    write(join(cli, 'web', 'index.html'), 'old UI');
    write(join(web, 'index.html'), 'old UI');
    await withStagedOutputs(root, async (stage) => {
      const stagedCli = join(stage, 'cli');
      const stagedWeb = join(stage, 'web');
      write(join(stagedCli, 'cli.js'), 'new CLI');
      expect(readFileSync(join(cli, 'cli.js'), 'utf8')).toBe('old CLI');
      write(join(stagedCli, 'web', 'index.html'), 'new UI');
      write(join(stagedWeb, 'index.html'), 'new UI');
      expect(readFileSync(join(web, 'index.html'), 'utf8')).toBe('old UI');
      return [
        { staged: stagedWeb, target: web },
        { staged: stagedCli, target: cli },
      ];
    });
    expect(readFileSync(join(cli, 'cli.js'), 'utf8')).toBe('new CLI');
    expect(readFileSync(join(cli, 'web', 'index.html'), 'utf8')).toBe('new UI');
    expect(readFileSync(join(web, 'index.html'), 'utf8')).toBe('new UI');
    expect(readdirSync(root).some((name) => name.startsWith('.build-'))).toBe(false);
  });

  it('preserves the last successful distribution if a later build step fails', async () => {
    const cli = join(root, 'dist');
    write(join(cli, 'cli.js'), 'working CLI');
    write(join(cli, 'web', 'index.html'), 'working UI');
    await expect(
      withStagedOutputs(root, async (stage) => {
        write(join(stage, 'cli', 'cli.js'), 'unfinished CLI');
        throw new Error('UI build failed');
      }),
    ).rejects.toThrow('UI build failed');
    expect(readFileSync(join(cli, 'cli.js'), 'utf8')).toBe('working CLI');
    expect(readFileSync(join(cli, 'web', 'index.html'), 'utf8')).toBe('working UI');
    expect(readdirSync(root)).toEqual(['dist']);
  });

  it('restores already replaced outputs when publication fails', async () => {
    const cli = join(root, 'dist');
    write(join(cli, 'cli.js'), 'working CLI');
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'a file cannot be an output parent');
    await expect(
      withStagedOutputs(root, async (stage) => {
        const stagedCli = join(stage, 'cli');
        const stagedWeb = join(stage, 'web');
        write(join(stagedCli, 'cli.js'), 'new CLI');
        write(join(stagedWeb, 'index.html'), 'new UI');
        return [
          { staged: stagedCli, target: cli },
          { staged: stagedWeb, target: join(blocked, 'dist') },
        ];
      }),
    ).rejects.toThrow();
    expect(readFileSync(join(cli, 'cli.js'), 'utf8')).toBe('working CLI');
    expect(readdirSync(root).toSorted()).toEqual(['blocked', 'dist']);
  });
});
