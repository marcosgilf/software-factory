import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('API smoke test', () => {
  it('returns a typed health response', async () => {
    const response = await createApp().request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
