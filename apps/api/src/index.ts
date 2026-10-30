import { serve } from '@hono/node-server';
import { SqliteSessionCatalog } from '@factory/agent-runtime';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const catalog = new SqliteSessionCatalog(
  process.env.FACTORY_DATA_DIR === undefined ? {} : { directory: process.env.FACTORY_DATA_DIR },
);
const allowedOrigins = process.env.FACTORY_ALLOWED_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

await catalog.start();
const server = serve({
  fetch: createApp({
    catalog,
    ...(process.env.FACTORY_API_TOKEN === undefined
      ? {}
      : { apiToken: process.env.FACTORY_API_TOKEN }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  }).fetch,
  port,
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await catalog.close();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
