import { timingSafeEqual } from 'node:crypto';
import { cors } from 'hono/cors';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  healthResponse,
  type ApiErrorResponse,
  type SessionId,
  type SessionListResponse,
  type SessionResponse,
  type TaskListResponse,
  type TaskResponse,
} from '@factory/contracts';
import type { SessionCatalog } from '@factory/agent-runtime';
import { SessionEventHubs, type SessionEventSubscription } from './session-events.js';

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:4321', 'http://127.0.0.1:4321'];

export interface AppOptions {
  readonly catalog?: SessionCatalog;
  readonly apiToken?: string;
  readonly allowedOrigins?: readonly string[];
}

export function createApp(options: AppOptions = {}): Hono {
  const apiToken = options.apiToken ?? process.env.FACTORY_API_TOKEN;
  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  const events = new SessionEventHubs();
  const app = new Hono();

  app.use('*', async (context, next) => {
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      // Keep logs content-free. Never include query strings, headers, or response bodies.
      console.log(
        JSON.stringify({
          method: context.req.method,
          path: new URL(context.req.url).pathname,
          status: context.res.status,
          durationMs: Date.now() - startedAt,
        }),
      );
    }
  });

  app.onError((_error, context) =>
    jsonError(context, 500, 'internal_error', 'The request could not be completed.'),
  );

  app.get('/health', (context) => context.json(healthResponse));

  app.use(
    '/api/*',
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 600,
    }),
  );
  app.use('/api/*', async (context, next) => {
    if (apiToken === undefined || apiToken.length === 0) {
      return jsonError(context, 503, 'api_not_configured', 'API authentication is not configured.');
    }
    if (!hasValidBearerToken(context.req.header('authorization'), apiToken)) {
      return jsonError(context, 401, 'unauthorized', 'A valid bearer token is required.');
    }
    await next();
  });

  app.get('/api/sessions', async (context) => {
    const catalog = requireCatalog(context, options.catalog);
    if (catalog instanceof Response) return catalog;
    const response: SessionListResponse = { sessions: await catalog.listSessions() };
    return context.json(response);
  });

  app.post('/api/sessions', async (context) => {
    const catalog = requireCatalog(context, options.catalog);
    if (catalog instanceof Response) return catalog;
    const session = await catalog.createSession();
    const response: SessionResponse = { session: (await session.getSnapshot()).session };
    return context.json(response, 201);
  });

  app.get('/api/sessions/:sessionId', async (context) => {
    const session = findSession(context, options.catalog);
    if (session instanceof Response) return session;
    const response: SessionResponse = { session: (await session.getSnapshot()).session };
    return context.json(response);
  });

  app.get('/api/sessions/:sessionId/tasks', async (context) => {
    const session = findSession(context, options.catalog);
    if (session instanceof Response) return session;
    const response: TaskListResponse = { tasks: (await session.getSnapshot()).tasks };
    return context.json(response);
  });

  app.get('/api/sessions/:sessionId/tasks/:taskId', async (context) => {
    const session = findSession(context, options.catalog);
    if (session instanceof Response) return session;
    const task = await session.getTask(context.req.param('taskId'));
    if (task === undefined) {
      return jsonError(context, 404, 'task_not_found', 'The task does not exist in this session.');
    }
    const response: TaskResponse = { task };
    return context.json(response);
  });

  app.get('/api/sessions/:sessionId/events', async (context) => {
    const session = findSession(context, options.catalog);
    if (session instanceof Response) return session;
    const subscription = await events
      .forSession(session)
      .subscribe(context.req.header('last-event-id'));
    const initial = [...subscription.initial];
    const encoder = new TextEncoder();
    const requestSignal = context.req.raw.signal;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      subscription.close();
    };

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) return;
        if (initial.length > 0) {
          controller.enqueue(encoder.encode(formatSse(initial.shift()!)));
          return;
        }

        const event = await nextOrHeartbeat(subscription);
        if (closed) return;
        controller.enqueue(
          encoder.encode(event === undefined ? ': keep-alive\n\n' : formatSse(event)),
        );
      },
      cancel: close,
    });
    requestSignal.addEventListener('abort', close, { once: true });

    return context.newResponse(body, {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return app;
}

function requireCatalog(context: Context, catalog?: SessionCatalog) {
  if (catalog === undefined) {
    return jsonError(context, 503, 'runtime_not_ready', 'The session runtime is not available.');
  }
  return catalog;
}

function findSession(context: Context, catalog?: SessionCatalog) {
  const required = requireCatalog(context, catalog);
  if (required instanceof Response) return required;

  const rawId = context.req.param('sessionId');
  if (rawId === undefined || !SESSION_ID_PATTERN.test(rawId)) {
    return jsonError(context, 400, 'invalid_session_id', 'The session ID is invalid.');
  }
  const session = required.getSession(rawId as SessionId);
  if (session === undefined) {
    return jsonError(context, 404, 'session_not_found', 'The session does not exist.');
  }
  return session;
}

function hasValidBearerToken(authorization: string | undefined, expected: string): boolean {
  if (authorization === undefined) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (match?.[1] === undefined) return false;
  const actualBytes = Buffer.from(match[1]);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function jsonError(context: Context, status: ContentfulStatusCode, code: string, message: string) {
  const response: ApiErrorResponse = { error: { code, message } };
  return context.json(response, status);
}

function formatSse(event: {
  readonly id: string;
  readonly type: string;
  readonly snapshot: unknown;
}) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function nextOrHeartbeat(subscription: SessionEventSubscription) {
  let timer: number | undefined;
  try {
    return await Promise.race([
      subscription.next(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, 15_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
