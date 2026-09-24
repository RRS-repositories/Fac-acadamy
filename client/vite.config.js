import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In production nginx serves client/dist at / and proxies /api to the API on
// the same origin (academy.fastactionclaims.com). The dev proxy mirrors that,
// so there is no CORS setup anywhere.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4100',
    },
  },
  build: {
    outDir: 'dist',
    // The bundle is public: never ship source maps.
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './test/setup.js',
    globals: false,
    // One file at a time: several jsdom suites in parallel on a slow disk
    // time out spuriously. The server config does the same.
    fileParallelism: false,
  },
});
