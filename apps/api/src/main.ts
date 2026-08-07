import { loadConfig } from '@p80/core';
import { buildServer } from './server.js';

const config = loadConfig();
const server = await buildServer(config);

// Bind to 127.0.0.1 (spec §32.5, `CLAUDE.md` rule 13). The host comes from config so
// that LAN exposure stays an explicit, warned-about act rather than an edit to this line.
await server.app.listen({ host: config.P80_BIND_HOST, port: config.P80_API_PORT });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
