import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    daemon: 'src/daemon.ts',
    'workers/parse-worker': 'src/workers/parse-worker.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  dts: false,
  fixedExtension: false,
  // 配布物はruntime依存を持たない。bundleしてよい外部packageをここで列挙する。
  deps: {
    onlyBundle: [
      '@hono/node-server',
      '@tanstack/markdown',
      'chokidar',
      'commander',
      'entities',
      'fdir',
      'hono',
      'parse5',
      'picomatch',
      'readdirp',
      'tinyglobby',
      'zod',
    ],
  },
});
