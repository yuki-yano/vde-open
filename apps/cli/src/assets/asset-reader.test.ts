import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAssetFile } from './asset-reader.ts';

let base: string;
// The assets-root, with symlinks resolved as the service gives it.
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-asset-reader-')));
  root = join(base, 'site');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(base, 'outside'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const write = (path: string, content: string) => {
  writeFileSync(path, content);
  return path;
};

const link = (target: string, name: string) => symlinkSync(target, join(root, name));

describe('SEC-011 reaching outside the root via symlinks', () => {
  it('reads a symlink only when its target is inside the root, not hidden, and of the same type', async () => {
    link(write(join(base, 'outside', 'secret.png'), 'secret'), 'link.png');
    link(join(base, 'outside'), 'linked');
    link(write(join(root, '.env'), 'KEY=secret'), 'public.png');
    link(write(join(root, '.git', 'secret.png'), 'secret'), 'logo.png');
    link(join(root, '.git'), 'assets');
    link(write(join(root, 'private.json'), '{"secret":1}'), 'data.png');
    link(write(join(root, 'notes.txt'), 'secret'), 'style.css');
    link(write(join(root, 'a.png'), 'png'), 'alias.png');

    const refused = {
      'link.png': 'outside-root',
      'linked/secret.png': 'outside-root',
      'public.png': 'hidden-target',
      'logo.png': 'hidden-target',
      'assets/secret.png': 'hidden-target',
      'data.png': 'type-mismatch',
      'style.css': 'type-mismatch',
    };
    for (const [logicalPath, reason] of Object.entries(refused)) {
      expect(await readAssetFile(root, logicalPath), logicalPath).toEqual({ ok: false, reason });
    }
    expect(await readAssetFile(root, 'alias.png')).toMatchObject({
      ok: true,
      bytes: Buffer.from('png'),
    });
  });
});
