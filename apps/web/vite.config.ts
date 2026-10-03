import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// bundleに入れたmoduleの一覧を、中間fileとして書く。
// scripts/build.tsが、これからlicense noticeを作り、fileは消す。
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

// `pnpm dev`が渡す開発用daemonのorigin。buildでは使わない。
const devBackend = process.env['VDE_OPEN_DEV_BACKEND'];

export default defineConfig({
  plugins: [react(), tailwindcss(), recordBundledModules],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 開発用のUIもloopbackだけで待ち受ける。
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
