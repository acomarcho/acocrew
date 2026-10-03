import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // .ts.net lets the Tailscale hostname reach the dev server
  server: { port: 5273, strictPort: true, allowedHosts: ['.ts.net'] },
});
