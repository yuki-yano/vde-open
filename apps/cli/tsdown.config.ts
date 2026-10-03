import { defineConfig } from 'tsdown';

// bundleに入れたmoduleの一覧を、配布物の外へ出す前の中間fileとして書く。
// scripts/build.tsが、これからlicense noticeを作り、fileは消す。
const recordBundledModules = {
  name: 'vde-open:record-bundled-modules',
  generateBundle(
    this: { emitFile: (file: { type: 'asset'; fileName: string; source: string }) => string },
    _options: unknown,
    bundle: Record<string, { type: string; moduleIds?: string[] }>,
  ) {
    const ids = new Set<string>();
    for (const output of Object.values(bundle)) {
      for (const id of output.moduleIds ?? []) ids.add(id);
    }
    this.emitFile({
      type: 'asset',
      fileName: 'bundled-modules.json',
      source: JSON.stringify([...ids].toSorted()),
    });
  },
};

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    daemon: 'src/daemon.ts',
    'workers/parse-worker': 'src/workers/parse-worker.ts',
    'workers/search-worker': 'src/workers/search-worker.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  dts: false,
  plugins: [recordBundledModules],
  fixedExtension: false,
  // 配布物はruntime依存を持たない。bundleしてよい外部packageをここで列挙する。
  deps: {
    onlyBundle: [
      '@hono/node-server',
      '@tanstack/markdown',
      'chokidar',
      'commander',
      'css-tree',
      'entities',
      'fdir',
      'hono',
      'minisearch',
      'parse5',
      'picomatch',
      'readdirp',
      'source-map-js',
      'tinyglobby',
      'zod',
    ],
  },
});
