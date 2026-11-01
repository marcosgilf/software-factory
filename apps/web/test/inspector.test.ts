import type { SessionEvent, SessionId, SessionSnapshot, TaskId } from '@factory/contracts';
import { describe, expect, it } from 'vitest';
import {
  applySessionEvent,
  parseSessionEvent,
  parseSseFrames,
  reconnectSchedule,
  resolveApiBase,
  type SseFrame,
} from '../src/lib/inspector.js';

describe('inspector SSE client', () => {
  it('allows plain HTTP only for loopback API URLs', () => {
    expect(resolveApiBase('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    expect(resolveApiBase('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveApiBase('https://factory.example')).toBe('https://factory.example');
    expect(() => resolveApiBase('http://192.168.1.20:3000')).toThrow('HTTPS');
  });

  it('backs off short stream failures and resets after a stable connection', () => {
    expect(reconnectSchedule(500, 1_000)).toEqual({ waitMs: 500, nextDelayMs: 1_000 });
    expect(reconnectSchedule(1_000, 1_000)).toEqual({ waitMs: 1_000, nextDelayMs: 2_000 });
    expect(reconnectSchedule(5_000, 30_000)).toEqual({ waitMs: 500, nextDelayMs: 500 });
  });

  it('parses event frames when line endings and JSON data cross stream chunks', async () => {
    const wireEvent = event('snapshot', snapshot('session-a' as SessionId, 0));
    const data = JSON.stringify({ ...wireEvent, id: 'epoch/session/1' }, null, 1)
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\r\n');
    const chunks = [
      'id: epoch/session/1\r',
      `\nevent: snapshot\r\n${data.slice(0, 45)}`,
      `${data.slice(45)}\r\n\r\n: heartbeat\n\n`,
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    const frames: SseFrame[] = [];
    for await (const frame of parseSseFrames(body)) frames.push(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 'epoch/session/1', event: 'snapshot' });
    expect(parseSessionEvent(frames[0]!)).toEqual({
      ...wireEvent,
      id: 'epoch/session/1',
    });
  });

  it('applies snapshots and forward updates while ignoring stale or foreign updates', () => {
    const first = snapshot('session-a' as SessionId, 0);
    const next = snapshot('session-a' as SessionId, 1);
    const other = snapshot('session-b' as SessionId, 2);
    const current = applySessionEvent(undefined, event('snapshot', first));

    expect(applySessionEvent(current, event('update', next))).toEqual(next);
    expect(applySessionEvent(next, event('update', first))).toEqual(next);
    expect(applySessionEvent(next, event('update', other))).toEqual(next);
    expect(applySessionEvent(next, event('resync', first))).toEqual(first);
  });
});

function snapshot(sessionId: SessionId, revision: number): SessionSnapshot {
  return {
    session: { id: sessionId, status: 'running', taskCount: 1, activeTaskCount: 1 },
    tasks: [{ id: 1 as TaskId, kind: 'test.pause', status: 'running' }],
    revision,
  };
}

function event(type: SessionEvent['type'], value: SessionSnapshot): SessionEvent {
  return { type, id: `cursor-${value.revision}`, snapshot: value };
}
