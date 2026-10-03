import { defineConfig } from 'vite-plus';

// Formatting and lint rules for the whole repo. `vp check` reads them from here.
export default defineConfig({
  fmt: {
    singleQuote: true,
    printWidth: 120,
    ignorePatterns: ['**/routeTree.gen.ts', 'pnpm-lock.yaml'],
  },
  lint: {
    ignorePatterns: ['**/routeTree.gen.ts'],
    plugins: ['typescript', 'react'],
  },
});
