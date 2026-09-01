// Dedicated test server: no HMR, no file watching, so background agents editing
// files can't reload the page mid-scenario.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5180,
    host: true,
    hmr: false,
    watch: { ignored: ['**/*'] },
    fs: { strict: false },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
