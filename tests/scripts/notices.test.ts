import { describe, expect, it } from 'vitest';

import { packageDirOfModule } from '../../scripts/notices.ts';

describe('bundleしたmoduleのpackage', () => {
  it.each([
    [
      'POSIXのpath',
      '/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom/cjs/client.js',
      '/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom',
    ],
    [
      'Windowsのpath（Viteは`/`へそろえる）',
      'C:/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom/client.js',
      'C:/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom',
    ],
    [
      'Windowsのpath（OSの区切り）',
      'C:\\repo\\node_modules\\.pnpm\\minisearch@7.2.0\\node_modules\\minisearch\\dist\\es\\index.js',
      'C:/repo/node_modules/.pnpm/minisearch@7.2.0/node_modules/minisearch',
    ],
    [
      'scoped package',
      'C:\\repo\\node_modules\\@base-ui\\react\\esm\\dialog\\index.js',
      'C:/repo/node_modules/@base-ui/react',
    ],
    [
      'scoped package（`/`区切り）',
      '/repo/node_modules/.pnpm/@hono+node-server@2.1.3/node_modules/@hono/node-server/dist/index.mjs',
      '/repo/node_modules/.pnpm/@hono+node-server@2.1.3/node_modules/@hono/node-server',
    ],
  ])('%s', (_name, id, expected) => {
    expect(packageDirOfModule(id)).toBe(expected);
  });

  it('workspaceのsourceと、packageの中を指さないIDは対象にしない', () => {
    expect(packageDirOfModule('/repo/packages/shared/src/index.ts')).toBeNull();
    expect(packageDirOfModule('C:\\repo\\apps\\web\\src\\App.tsx')).toBeNull();
    expect(packageDirOfModule('/repo/node_modules/react')).toBeNull();
  });
});
