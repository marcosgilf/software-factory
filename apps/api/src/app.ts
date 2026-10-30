import { healthResponse } from '@factory/contracts';
import { Hono } from 'hono';

export function createApp(): Hono {
  return new Hono()
    .use('*', async (context, next) => {
      const startedAt = Date.now();
      await next();
      console.log(
        JSON.stringify({
          method: context.req.method,
          path: new URL(context.req.url).pathname,
          status: context.res.status,
          durationMs: Date.now() - startedAt,
        }),
      );
    })
    .get('/health', (context) => context.json(healthResponse));
}
