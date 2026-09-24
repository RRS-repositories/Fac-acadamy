import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { api: 'src/entry/api.ts', worker: 'src/entry/worker.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // shared/ ships as .ts source with no build step, so it must be bundled in.
  noExternal: ['@fac-academy/shared'],
});
