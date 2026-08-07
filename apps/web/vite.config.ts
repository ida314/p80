import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The dev server binds loopback (spec §32.5, `CLAUDE.md` rule 13), same as the API and
 * the NLP sidecar. `strictPort` matters more than it looks: the API's CORS allowlist is
 * built from `P80_WEB_PORT`, so a Vite that quietly moved to the next free port would
 * come up looking fine and fail every request.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'P80_');
  const host = env.P80_BIND_HOST ?? '127.0.0.1';
  const port = Number(env.P80_WEB_PORT ?? 5173);
  const apiPort = Number(env.P80_API_PORT ?? 5180);

  return {
    plugins: [react()],
    server: {
      host,
      port,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${apiPort}`,
          changeOrigin: false,
        },
      },
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
