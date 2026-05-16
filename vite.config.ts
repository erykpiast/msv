import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: '.',
  plugins: [react()],
  resolve: { alias: { '@app': '/src/inspect-app' } },
  // server.fs.allow and the /inspect-view.json middleware are set
  // programmatically by src/inspect/server.js per invocation.
});
