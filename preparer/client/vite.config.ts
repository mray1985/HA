import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** Replace the CSP connect-src placeholder based on build mode. */
function cspPlugin(): Plugin {
  return {
    name: 'csp-connect-src',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const apiOrigin = process.env.VITE_API_ORIGIN || process.env.VITE_API_BASE || '';
        // Always keep blob: (PDF/worker fetch). Dev allows optional local BYOK server.
        // Production defaults to local-first ('self' + blob); add API origin only when set.
        const connectSrc = ctx.server
          ? "'self' blob: http://localhost:3002 http://127.0.0.1:3002"
          : apiOrigin
            ? `'self' blob: ${apiOrigin}`
            : "'self' blob:";
        return html.replace(
          /connect-src\s+'self'[^;]*/,
          `connect-src ${connectSrc}`,
        );
      },
    },
  };
}

/**
 * Record in dist/build-info.json whether the build carried the Syncfusion
 * license key (never the key itself). The installer refuses a client built
 * without it (desktop/scripts/check-client.mjs): without a key every page
 * using Syncfusion shows its license banner.
 */
function buildInfoPlugin(): Plugin {
  let licensed = false;
  // The app's API is its own server (same origin). A build pointed at another
  // origin would send sign-ins and model requests off the computer, against
  // the Privacy Policy: recorded here, and the installer refuses it.
  let apiOrigin = '';
  return {
    name: 'hatax-build-info',
    apply: 'build',
    configResolved(config) {
      licensed = Boolean(String(config.env.VITE_SYNCFUSION_LICENSE_KEY ?? '').trim());
      apiOrigin = String(config.env.VITE_API_ORIGIN || config.env.VITE_API_BASE || process.env.VITE_API_ORIGIN || process.env.VITE_API_BASE || '').trim();
    },
    buildStart() {
      if (!licensed) {
        this.warn('VITE_SYNCFUSION_LICENSE_KEY is not set: Syncfusion components will show a license banner, and the installer will refuse this build.');
      }
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: `${JSON.stringify({ syncfusionLicensed: licensed, apiOrigin, builtAt: new Date().toISOString() }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    cspPlugin(),
    buildInfoPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'icons/icon.svg',
        'icons/apple-touch-icon.png',
        'icons/favicon-32.png',
      ],
      manifest: {
        name: 'HA Tax Preparer',
        short_name: 'HA Preparer',
        description: "Automated tax preparation that runs on the preparer's own machine.",
        theme_color: '#0F172A',
        background_color: '#0F172A',
        display: 'standalone',
        start_url: '/preparer',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          syncfusion: [
            '@syncfusion/ej2-base',
            '@syncfusion/ej2-react-charts',
            '@syncfusion/ej2-react-circulargauge',
            '@syncfusion/ej2-react-pdfviewer',
            '@syncfusion/ej2-pdfviewer',
            '@syncfusion/ej2-pdf',
            '@syncfusion/ej2-pdf-data-extract',
          ],
        },
      },
    },
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
  worker: {
    format: 'es',
  },
});
