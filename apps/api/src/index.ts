import { serve } from '@hono/node-server';
import { SqliteSessionCatalog } from '@factory/agent-runtime';
import { createApp } from './app.js';
import { DockerMockIssueWorkspaceExecutor } from './docker-mock-issue-workspace-executor.js';
import { createMockIssueToPrRuntime } from './mock-issue-to-pr.js';
import { SessionEventHubs } from './session-events.js';

const port = Number(process.env.PORT ?? 3000);
const mockWorkflow =
  process.env.FACTORY_ISSUE_TO_PR_MODE === 'mock'
    ? createMockIssueToPrRuntime(new DockerMockIssueWorkspaceExecutor())
    : undefined;
const catalog = new SqliteSessionCatalog({
  ...(process.env.FACTORY_DATA_DIR === undefined
    ? {}
    : { directory: process.env.FACTORY_DATA_DIR }),
  ...(mockWorkflow === undefined ? {} : { harnessOptions: mockWorkflow.harnessOptions }),
});
const sessionEventHubs = new SessionEventHubs();
const allowedOrigins = process.env.FACTORY_ALLOWED_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

await catalog.start();
const server = serve({
  hostname: '127.0.0.1',
  fetch: createApp({
    catalog,
    ...(process.env.FACTORY_API_TOKEN === undefined
      ? {}
      : { apiToken: process.env.FACTORY_API_TOKEN }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    ...(mockWorkflow === undefined ? {} : { issueToPrService: mockWorkflow.issueToPrService }),
    sessionEventHubs,
  }).fetch,
  port,
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  sessionEventHubs.close();
  try {
    await serverClosed;
  } finally {
    await catalog.close();
  }
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
