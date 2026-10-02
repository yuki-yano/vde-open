import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev`が渡す開発用daemonのorigin。buildでは使わない。
const devBackend = process.env['VDE_OPEN_DEV_BACKEND'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
