import { defineConfig } from 'tsdown';

// Write the list of bundled modules as an intermediate file that stays out of the distributed package.
// scripts/build.ts builds the license notice from it and then deletes the file.
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
  // The distributed package has no runtime dependencies. External packages that may be bundled are listed here.
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
