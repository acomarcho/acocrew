import { SERVER_PORT, WS_PATH } from '@acocrew/shared';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { defineConfig } from 'vite-plus';

const server = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react' }),
    react(),
    tailwindcss(),
    // Excalidraw's fonts, served by us so drawing a diagram never asks a CDN (see drawing.tsx).
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@excalidraw/excalidraw/dist/prod/fonts/**/*',
          dest: 'excalidraw',
          rename: { stripBase: 5 },
        },
      ],
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    // .ts.net lets the Tailscale hostname reach the dev server
    allowedHosts: ['.ts.net'],
    // In dev the web app and the server look like one address.
    proxy: {
      // xfwd tells the server which address the browser used. It checks that against where the page came from.
      '/api': { target: server, xfwd: true },
      [WS_PATH]: { target: server, ws: true, xfwd: true },
    },
  },
});
