import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5178, host: true, fs: { strict: false } },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('rapier')) return 'rapier';
        },
      },
    },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
