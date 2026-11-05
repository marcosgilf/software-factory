import type { SessionEvent, SessionId, SessionSnapshot, TaskId } from '@factory/contracts';
import { describe, expect, it, vi } from 'vitest';
import { connectInspector } from '../src/scripts/inspector.js';

const SESSION_A = 'session-a' as SessionId;
const SESSION_B = 'session-b' as SessionId;

describe('inspector session connections', () => {
  it('clears stale errors on reconnect and requests a fresh snapshot after switching back', async () => {
    const document = new FakeDocument();
    const eventRequests: {
      readonly sessionId: SessionId;
      readonly lastEventId: string | null;
      readonly close: () => void;
    }[] = [];
    const sequenceBySession = new Map<SessionId, number>();
    let failNextSessionA = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/sessions') {
          return new Response(
            JSON.stringify({
              sessions: [
                { id: SESSION_A, status: 'idle' },
                { id: SESSION_B, status: 'idle' },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        const sessionId = decodeURIComponent(url.pathname.split('/').at(-2)!) as SessionId;
        const lastEventId = new Headers(init?.headers).get('Last-Event-ID');
        if (sessionId === SESSION_A && failNextSessionA) {
          failNextSessionA = false;
          eventRequests.push({ sessionId, lastEventId, close: () => undefined });
          throw new TypeError('Failed to fetch');
        }

        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const close = () => {
          if (controller === undefined) return;
          try {
            controller.close();
          } catch {
            // The stream may already be closed by its abort signal.
          }
        };
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            if (lastEventId === null) {
              const sequence = (sequenceBySession.get(sessionId) ?? 0) + 1;
              sequenceBySession.set(sessionId, sequence);
              const event = sessionEvent(sessionId, sequence);
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
            }
            const signal = init?.signal;
            if (signal?.aborted) close();
            else signal?.addEventListener('abort', close, { once: true });
          },
        });
        eventRequests.push({ sessionId, lastEventId, close });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    connectInspector(document as unknown as Document);

    try {
      await Promise.resolve(
        document.get('connection-form').dispatch('submit', new Event('submit')),
      );
      await waitFor(() => document.get('message').textContent === 'Session state is current.');
      expect(document.get('session-id').textContent).toContain(SESSION_A);

      failNextSessionA = true;
      eventRequests[0]!.close();
      await waitFor(() => document.get('message').textContent === 'Failed to fetch Reconnecting…');
      expect(eventRequests[1]?.lastEventId).toBe(`epoch/${SESSION_A}/1`);

      await waitFor(
        () =>
          document.get('message').textContent === 'Live updates connected; waiting for updates.',
      );
      expect(eventRequests[2]?.lastEventId).toBe(`epoch/${SESSION_A}/1`);

      document.get('session-select').value = SESSION_B;
      document.get('session-select').dispatch('change', new Event('change'));
      await waitFor(
        () => document.get('session-id').textContent === `Session ${SESSION_B} · 1 task(s)`,
      );

      document.get('session-select').value = SESSION_A;
      document.get('session-select').dispatch('change', new Event('change'));
      await waitFor(
        () => document.get('session-id').textContent === `Session ${SESSION_A} · 1 task(s)`,
      );
      expect(eventRequests.at(-1)).toMatchObject({ sessionId: SESSION_A, lastEventId: null });
    } finally {
      document.get('api-url').value = 'not a URL';
      await Promise.resolve(
        document.get('connection-form').dispatch('submit', new Event('submit')),
      );
      vi.unstubAllGlobals();
    }
  }, 10_000);

  it('starts and approves an issue workflow from the browser inspector', async () => {
    const document = new FakeDocument();
    const requests: {
      method: string;
      path: string;
      authorization: string | null;
      body?: string;
    }[] = [];
    let approvalSubmitted = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        requests.push({
          method,
          path: url.pathname,
          authorization: new Headers(init?.headers).get('Authorization'),
          ...(init?.body === undefined ? {} : { body: String(init.body) }),
        });
        if (url.pathname === '/api/sessions') {
          return jsonResponse({
            sessions: [{ id: SESSION_A, status: 'idle', taskCount: 0, activeTaskCount: 0 }],
          });
        }
        if (url.pathname.endsWith('/events')) {
          const event = sessionEvent(SESSION_A, 1);
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
              const close = () => {
                try {
                  controller.close();
                } catch {
                  // The stream may already be closed.
                }
              };
              if (init?.signal?.aborted) close();
              else init?.signal?.addEventListener('abort', close, { once: true });
            },
          });
          return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.pathname.endsWith('/workflows/issue-to-pr') && method === 'POST') {
          return jsonResponse(
            {
              task: { id: 7, kind: 'factory.workflow.issue-to-pr', status: 'running' },
            },
            202,
          );
        }
        if (url.pathname.endsWith('/tasks/7/approval') && method === 'POST') {
          approvalSubmitted = true;
          return jsonResponse(
            { task: { id: 7, kind: 'factory.workflow.issue-to-pr', status: 'running' } },
            202,
          );
        }
        if (url.pathname.endsWith('/tasks/7/approval')) {
          return jsonResponse(
            approvalSubmitted
              ? {
                  status: 'completed',
                  pullRequestUrl: 'https://github.com/factory-mock/demo/pull/1',
                }
              : { status: 'pending' },
          );
        }
        throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      }),
    );
    connectInspector(document as unknown as Document);

    try {
      await Promise.resolve(
        document.get('connection-form').dispatch('submit', new Event('submit')),
      );
      await waitFor(() => document.get('start-issue-to-pr').disabled === false);
      document.get('issue-number').value = '42';
      await Promise.resolve(
        document.get('issue-to-pr-form').dispatch('submit', new Event('submit')),
      );
      await waitFor(() => document.get('workflow-actions').hidden === false);
      expect(document.get('workflow-status').textContent).toBe('Waiting for your approval.');

      document.get('approve-issue-to-pr').dispatch('click', new Event('click'));
      await waitFor(() => document.get('workflow-status').textContent === 'Draft PR created.');
      expect(document.get('workflow-result').hidden).toBe(false);
      expect(document.get('workflow-pr-url').textContent).toBe(
        'https://github.com/factory-mock/demo/pull/1',
      );
      const start = requests.find(({ path }) => path.endsWith('/workflows/issue-to-pr'));
      expect(JSON.parse(start?.body ?? '{}')).toEqual({ issueNumber: 42 });
      expect(
        requests.every(({ authorization }) => authorization === 'Bearer test-device-token'),
      ).toBe(true);
    } finally {
      document.get('api-url').value = 'not a URL';
      await Promise.resolve(
        document.get('connection-form').dispatch('submit', new Event('submit')),
      );
      vi.unstubAllGlobals();
    }
  }, 10_000);

  it('shows a real-mode eligibility rejection without a PR action', async () => {
    const document = new FakeDocument();
    const requests: { method: string; path: string; body?: string }[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        requests.push({
          method,
          path: url.pathname,
          ...(init?.body === undefined ? {} : { body: String(init.body) }),
        });
        if (url.pathname === '/api/sessions') {
          return jsonResponse({
            sessions: [{ id: SESSION_A, status: 'idle', taskCount: 0, activeTaskCount: 0 }],
          });
        }
        if (url.pathname.endsWith('/events')) {
          const event = sessionEvent(SESSION_A, 1);
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
              init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
            },
          });
          return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.pathname.endsWith('/workflows/issue-to-pr') && method === 'POST') {
          return jsonResponse(
            {
              task: { id: 8, kind: 'factory.workflow.issue-to-pr', status: 'running' },
            },
            202,
          );
        }
        if (url.pathname.endsWith('/tasks/8/approval')) return jsonResponse({ status: 'rejected' });
        throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      }),
    );
    connectInspector(document as unknown as Document);

    try {
      await Promise.resolve(
        document.get('connection-form').dispatch('submit', new Event('submit')),
      );
      await waitFor(() => document.get('start-issue-to-pr').disabled === false);
      document.get('issue-number').value = '43';
      await Promise.resolve(
        document.get('issue-to-pr-form').dispatch('submit', new Event('submit')),
      );
      await waitFor(
        () => document.get('workflow-status').textContent === 'Issue workflow rejected.',
      );

      expect(document.get('workflow-actions').hidden).toBe(true);
      expect(document.get('workflow-result').hidden).toBe(true);
      const start = requests.find(({ path }) => path.endsWith('/workflows/issue-to-pr'));
      expect(JSON.parse(start?.body ?? '{}')).toEqual({ issueNumber: 43 });
    } finally {
      document.get('api-url').value = 'not a URL';
      await Promise.resolve(
        document.get('connection-form').dispatch('submit', new Event('submit')),
      );
      vi.unstubAllGlobals();
    }
  }, 10_000);
});

class FakeElement {
  value = '';
  disabled = false;
  hidden = false;
  textContent = '';
  className = '';
  colSpan = 1;
  readonly children: FakeElement[] = [];
  readonly #listeners = new Map<string, (event: Event) => unknown>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    this.#listeners.set(type, callback as unknown as (event: Event) => unknown);
  }

  dispatch(type: string, event: Event): unknown {
    return this.#listeners.get(type)?.(event);
  }

  replaceChildren(...children: Node[]): void {
    this.children.splice(0, this.children.length, ...(children as unknown as FakeElement[]));
  }

  append(...children: Node[]): void {
    this.children.push(...(children as unknown as FakeElement[]));
  }

  setCustomValidity(_message: string): void {}

  reportValidity(): boolean {
    return true;
  }
}

class FakeDocument {
  readonly #elements = new Map<string, FakeElement>();

  constructor() {
    for (const id of [
      'connection-form',
      'api-url',
      'api-token',
      'connect-button',
      'session-select',
      'create-session',
      'message',
      'session-id',
      'session-status',
      'task-list',
      'issue-to-pr-form',
      'issue-number',
      'start-issue-to-pr',
      'workflow-progress-label',
      'workflow-progress',
      'workflow-status',
      'workflow-actions',
      'approve-issue-to-pr',
      'reject-issue-to-pr',
      'workflow-result',
      'workflow-pr-url',
    ]) {
      this.#elements.set(id, new FakeElement());
    }
    this.get('api-url').value = 'http://127.0.0.1:3000';
    this.get('api-token').value = 'test-device-token';
    this.get('start-issue-to-pr').disabled = true;
    this.get('workflow-progress-label').hidden = true;
    this.get('workflow-progress').hidden = true;
    this.get('workflow-actions').hidden = true;
    this.get('workflow-result').hidden = true;
  }

  querySelector<E extends Element = Element>(selector: string): E | null {
    return (this.#elements.get(selector.slice(1)) as unknown as E | undefined) ?? null;
  }

  createElement(_tagName: string): HTMLElement {
    return new FakeElement() as unknown as HTMLElement;
  }

  get(id: string): FakeElement {
    return this.#elements.get(id)!;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionEvent(sessionId: SessionId, sequence: number): SessionEvent {
  const snapshot: SessionSnapshot = {
    session: { id: sessionId, status: 'idle', taskCount: 1, activeTaskCount: 0 },
    tasks: [{ id: 1 as TaskId, kind: 'test.pause', status: 'completed' }],
    revision: sequence - 1,
  };
  return { type: 'snapshot', id: `epoch/${sessionId}/${sequence}`, snapshot };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for inspector state.');
}
