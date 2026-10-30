import { healthResponse } from '@factory/contracts';
import { Hono } from 'hono';

export function createApp(): Hono {
  return new Hono().get('/health', (context) => context.json(healthResponse));
}
