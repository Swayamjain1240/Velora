import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client holds no secrets (control #1/#16): only VITE_ public values are
// baked in. In dev, /api is proxied to the Express server so cookies are
// same-origin and the CSRF/session flow matches production behind one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        // Overridable so dev/e2e can point at whichever API port is running.
        target: process.env.VITE_API_PROXY || 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    css: false,
  },
});
