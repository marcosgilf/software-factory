import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

describe('API smoke test', () => {
  it('returns a typed health response', async () => {
    const response = await createApp().request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('logs request metadata without query parameters', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const response = await createApp().request('/health?access_token=secret');
      expect(response.status).toBe(200);
      expect(log).toHaveBeenCalledTimes(1);

      const line = String(log.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        method: 'GET',
        path: '/health',
        status: 200,
      });
      expect(line).not.toContain('secret');
    } finally {
      log.mockRestore();
    }
  });
});
