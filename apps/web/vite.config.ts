import { SERVER_PORT, WS_PATH } from '@acocrew/shared';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

const server = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react' }), react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    // .ts.net lets the Tailscale hostname reach the dev server
    allowedHosts: ['.ts.net'],
    // In dev the web app and the server look like one address.
    proxy: {
      '/api': server,
      [WS_PATH]: { target: server, ws: true },
    },
  },
});
