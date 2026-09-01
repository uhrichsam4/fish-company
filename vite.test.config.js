// Dedicated test server: HMR disabled so background agents editing files can't
// reload the page mid-scenario, but file watching stays ON so a manual reload
// always picks up the latest code.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5180, host: true, hmr: false, fs: { strict: false } },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
