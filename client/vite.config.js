import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client holds no secrets (control #1/#16): only VITE_ public values are
// baked in. In dev, /api is proxied to the Express server so cookies are
// same-origin and the CSRF/session flow matches production behind one origin.
//
// D-7: the SPA's own origin is not governed by the API's CSP, so the shell
// carries its own policy. It is injected as a <meta> tag at BUILD time (the
// built bundle has no inline script once the module-preload polyfill is off),
// which keeps the Vite dev preamble - an inline script - working locally. A
// hosting layer should still send the same policy as a response header.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // GSAP writes inline style properties; CSS variables are also set inline.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function cspMetaPlugin() {
  return {
    name: 'velora-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: CONTENT_SECURITY_POLICY,
            },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

// Development needs the same-origin API proxy plus the HMR websocket, and the
// React refresh preamble is inline. These headers apply to `vite` and
// `vite preview` only; the built index.html carries the strict policy above.
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const securityHeaders = {
  'Content-Security-Policy': DEV_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export default defineConfig({
  plugins: [react(), cspMetaPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    headers: securityHeaders,
    proxy: {
      '/api': {
        // Overridable so dev/e2e can point at whichever API port is running.
        target: process.env.VITE_API_PROXY || 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 4173,
    headers: securityHeaders,
  },
  build: {
    modulePreload: {
      // The polyfill is an INLINE script; without it the production shell needs
      // no 'unsafe-inline' for scripts at all.
      polyfill: false,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    css: false,
  },
});
