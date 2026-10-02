import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { cli: 'src/cli.ts', daemon: 'src/daemon.ts' },
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
      '@tanstack/markdown',
      'commander',
      'entities',
      'fdir',
      'parse5',
      'picomatch',
      'tinyglobby',
      'zod',
    ],
  },
});
