import { describe, expect, it } from 'vitest';

import { packageDirOfModule } from '../../scripts/notices.ts';

describe('package of a bundled module', () => {
  it.each([
    [
      'POSIX path',
      '/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom/cjs/client.js',
      '/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom',
    ],
    [
      'Windows path (Vite normalizes to `/`)',
      'C:/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom/client.js',
      'C:/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom',
    ],
    [
      'Windows path (OS separator)',
      'C:\\repo\\node_modules\\.pnpm\\minisearch@7.2.0\\node_modules\\minisearch\\dist\\es\\index.js',
      'C:/repo/node_modules/.pnpm/minisearch@7.2.0/node_modules/minisearch',
    ],
    [
      'scoped package',
      'C:\\repo\\node_modules\\@base-ui\\react\\esm\\dialog\\index.js',
      'C:/repo/node_modules/@base-ui/react',
    ],
    [
      'scoped package (`/` separator)',
      '/repo/node_modules/.pnpm/@hono+node-server@2.1.3/node_modules/@hono/node-server/dist/index.mjs',
      '/repo/node_modules/.pnpm/@hono+node-server@2.1.3/node_modules/@hono/node-server',
    ],
  ])('%s', (_name, id, expected) => {
    expect(packageDirOfModule(id)).toBe(expected);
  });

  it('ignores workspace sources and IDs that do not point inside a package', () => {
    expect(packageDirOfModule('/repo/packages/shared/src/index.ts')).toBeNull();
    expect(packageDirOfModule('C:\\repo\\apps\\web\\src\\App.tsx')).toBeNull();
    expect(packageDirOfModule('/repo/node_modules/react')).toBeNull();
  });
});
