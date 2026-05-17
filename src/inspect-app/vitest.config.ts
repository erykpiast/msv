import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(__dirname);

export default defineConfig({
  plugins: [react()],
  root,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(root, 'vitest.setup.ts')],
    include: ['**/*.test.ts', '**/*.test.tsx'],
  },
});
