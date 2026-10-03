import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Write the list of modules included in the bundle as an intermediate file.
// scripts/build.ts builds the license notice from it and then deletes the file.
const recordBundledModules: Plugin = {
  name: 'vde-open:record-bundled-modules',
  apply: 'build',
  generateBundle(_options, bundle) {
    const ids = new Set<string>();
    for (const output of Object.values(bundle)) {
      if (output.type === 'chunk') for (const id of output.moduleIds) ids.add(id);
    }
    this.emitFile({
      type: 'asset',
      fileName: 'bundled-modules.json',
      source: JSON.stringify([...ids].toSorted()),
    });
  },
};

// The origin of the development daemon passed by `pnpm dev`. Not used in builds.
const devBackend = process.env['VDE_OPEN_DEV_BACKEND'];

export default defineConfig({
  plugins: [react(), tailwindcss(), recordBundledModules],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // The development UI also listens only on loopback.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    ...(devBackend ? { proxy: { '/_/api': { target: devBackend, changeOrigin: true } } } : {}),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
