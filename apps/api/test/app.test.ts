import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineExtension, defineTask } from '@earendil-works/pi-durable';
import { describe, expect, it, vi } from 'vitest';
import { SqliteSessionCatalog } from '@factory/agent-runtime';
import type { SessionId } from '@factory/contracts';
import { createApp } from '../src/app.js';

const DEVICE_TOKEN = 'test-device-token';

describe('device API', () => {
  it('fails closed when the device token is missing or incorrect', async () => {
    const missing = await createApp({ apiToken: DEVICE_TOKEN }).request('/api/sessions');
    const incorrect = await createApp({ apiToken: DEVICE_TOKEN }).request('/api/sessions', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const unconfigured = await createApp().request('/api/sessions', {
      headers: { Authorization: 'Bearer anything' },
    });

    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(incorrect.status).toBe(401);
    expect(unconfigured.status).toBe(503);
  });

  it('keeps health open and allows the configured Astro development origin', async () => {
    const app = createApp({ apiToken: DEVICE_TOKEN });
    const health = await app.request('/health');
    const preflight = await app.request('/api/sessions', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:4321',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,last-event-id',
      },
    });

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:4321');
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'last-event-id',
    );
  });

  it('logs request metadata without query parameters or bearer credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const app = createApp({ apiToken: DEVICE_TOKEN });
      const response = await app.request(`/health?access_token=${DEVICE_TOKEN}`, {
        headers: { Authorization: `Bearer ${DEVICE_TOKEN}` },
      });
      const line = String(log.mock.calls[0]?.[0]);

      expect(response.status).toBe(200);
      expect(JSON.parse(line)).toMatchObject({ method: 'GET', path: '/health', status: 200 });
      expect(line).not.toContain(DEVICE_TOKEN);
    } finally {
      log.mockRestore();
    }
  });

  it('creates sessions and replays safe durable task updates after a disconnected client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-api-'));
    const entered = promiseSignal();
    const gate = promiseSignal();
    const PauseTask = defineTask<
      { readonly sensitive: string },
      { readonly phase: 'pause'; readonly sensitive: string },
      { readonly sensitive: string }
    >({
      name: 'factory.test.api-pause',
      version: 1,
      initial: (input) => ({ phase: 'pause', sensitive: input.sensitive }),
      phases: {
        pause: async (_task, runtime, context) => {
          entered.resolve();
          await gate.promise;
          await runtime.commit(
            () => ({
              status: 'terminal',
              outcome: { status: 'completed', result: { sensitive: 'private task result' } },
            }),
            context,
          );
        },
      },
      abort: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({
            status: 'terminal',
            outcome: { status: 'aborted', reason: 'The test task was cancelled.' },
          }),
          context,
        );
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'factory.test.api', tasks: [PauseTask] }));
    const catalog = new SqliteSessionCatalog({
      directory,
      harnessOptions: { models: createModels(), registry },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await catalog.start();
      const app = createApp({ catalog, apiToken: DEVICE_TOKEN });
      const created = await app.request('/api/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${DEVICE_TOKEN}` },
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { session: { id: string; status: string } };
      expect(createdBody.session.status).toBe('idle');

      const session = catalog.getSession(createdBody.session.id as SessionId);
      expect(session).toBeDefined();
      const taskId = await session!.harness
        .root(BACKGROUND_CONTEXT)
        .then((root) =>
          root.commit(
            (tx) =>
              tx.createTask(
                PauseTask,
                { sensitive: 'private task input' },
                { ownership: { kind: 'conversation' } },
              ),
            BACKGROUND_CONTEXT,
          ),
        );
      session!.harness.resume();
      await entered.promise;

      const firstStream = await app.request(`/api/sessions/${createdBody.session.id}/events`, {
        headers: { Authorization: `Bearer ${DEVICE_TOKEN}` },
      });
      expect(firstStream.headers.get('content-type')).toContain('text/event-stream');
      const firstReader = firstStream.body!.getReader();
      const firstEvent = await readSseEvent(firstReader);
      expect(firstEvent.type).toBe('snapshot');
      expect(firstEvent.snapshot.tasks).toMatchObject([{ id: taskId, status: 'running' }]);
      expect(JSON.stringify(firstEvent)).not.toContain('private task input');
      expect(JSON.stringify(firstEvent)).not.toContain('private task result');

      await firstReader.cancel();
      expect((await session!.getTask(String(taskId)))?.status).toBe('running');

      gate.resolve();
      await session!.harness.waitForIdle(BACKGROUND_CONTEXT);

      const replay = await app.request(`/api/sessions/${createdBody.session.id}/events`, {
        headers: {
          Authorization: `Bearer ${DEVICE_TOKEN}`,
          'Last-Event-ID': firstEvent.id,
        },
      });
      const replayReader = replay.body!.getReader();
      const update = await readSseEvent(replayReader);
      await replayReader.cancel();
      expect(update.type).toBe('update');
      expect(update.snapshot.tasks).toMatchObject([{ id: taskId, status: 'completed' }]);
      expect(JSON.stringify(update)).not.toContain('private task result');

      const resync = await app.request(`/api/sessions/${createdBody.session.id}/events`, {
        headers: {
          Authorization: `Bearer ${DEVICE_TOKEN}`,
          'Last-Event-ID': 'unknown-process/session/9',
        },
      });
      const resyncReader = resync.body!.getReader();
      const resyncEvent = await readSseEvent(resyncReader);
      await resyncReader.cancel();
      expect(resyncEvent.type).toBe('resync');
      expect(resyncEvent.snapshot.tasks).toMatchObject([{ id: taskId, status: 'completed' }]);

      const taskResponse = await app.request(
        `/api/sessions/${createdBody.session.id}/tasks/${taskId}`,
        { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } },
      );
      expect(taskResponse.status).toBe(200);
      const taskBody = await taskResponse.json();
      expect(taskBody).toEqual({
        task: expect.objectContaining({
          id: taskId,
          kind: 'factory.test.api-pause',
          status: 'completed',
        }),
      });
      expect(JSON.stringify(taskBody)).not.toContain('private');

      const sessions = await app.request('/api/sessions', {
        headers: { Authorization: `Bearer ${DEVICE_TOKEN}` },
      });
      expect(await sessions.json()).toMatchObject({
        sessions: [{ id: createdBody.session.id, status: 'completed', taskCount: 1 }],
      });

      expect(log.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain(DEVICE_TOKEN);
    } finally {
      gate.resolve();
      log.mockRestore();
      await catalog.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function promiseSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

type ReadEvent = {
  readonly id: string;
  readonly type: string;
  readonly snapshot: {
    readonly tasks: readonly { readonly id: string; readonly status: string }[];
  };
};

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!/\r\n\r\n|\n\n|\r\r/.test(buffer)) {
    const { done, value } = await reader.read();
    if (done) throw new Error('The SSE stream closed before an event arrived.');
    buffer += decoder.decode(value, { stream: true });
  }

  const data = buffer
    .split(/\r\n|\r|\n/)
    .find((line) => line.startsWith('data:'))
    ?.slice('data:'.length)
    .trimStart();
  if (data === undefined) throw new Error('The SSE event did not contain data.');
  return JSON.parse(data) as ReadEvent;
}
