import type {
  SessionId,
  SessionListResponse,
  SessionResponse,
  SessionSnapshot,
  TaskSummary,
} from '@factory/contracts';
import { applySessionEvent, parseSessionEvent, parseSseFrames } from '../lib/inspector.js';

interface ApiErrorBody {
  readonly error?: { readonly message?: string };
}

export function connectInspector(document: Document): void {
  const connectionForm = document.querySelector<HTMLFormElement>('#connection-form');
  const apiUrlInput = document.querySelector<HTMLInputElement>('#api-url');
  const tokenInput = document.querySelector<HTMLInputElement>('#api-token');
  const connectButton = document.querySelector<HTMLButtonElement>('#connect-button');
  const sessionSelect = document.querySelector<HTMLSelectElement>('#session-select');
  const createButton = document.querySelector<HTMLButtonElement>('#create-session');
  const message = document.querySelector<HTMLElement>('#message');
  const sessionIdLabel = document.querySelector<HTMLElement>('#session-id');
  const sessionStatus = document.querySelector<HTMLElement>('#session-status');
  const taskList = document.querySelector<HTMLTableSectionElement>('#task-list');

  if (
    connectionForm === null ||
    apiUrlInput === null ||
    tokenInput === null ||
    connectButton === null ||
    sessionSelect === null ||
    createButton === null ||
    message === null ||
    sessionIdLabel === null ||
    sessionStatus === null ||
    taskList === null
  ) {
    return;
  }

  const formElement = connectionForm as HTMLFormElement;
  const urlElement = apiUrlInput as HTMLInputElement;
  const secretElement = tokenInput as HTMLInputElement;
  const connectElement = connectButton as HTMLButtonElement;
  const selectorElement = sessionSelect as HTMLSelectElement;
  const createElement = createButton as HTMLButtonElement;
  const messageElement = message as HTMLElement;
  const sessionIdElement = sessionIdLabel as HTMLElement;
  const statusElement = sessionStatus as HTMLElement;
  const taskListElement = taskList as HTMLTableSectionElement;

  let apiToken = '';
  let activeSessionId: SessionId | undefined;
  let activeStream: AbortController | undefined;
  const lastEventIds = new Map<SessionId, string>();

  formElement.addEventListener('submit', async (event) => {
    event.preventDefault();
    activeStream?.abort();
    apiToken = secretElement.value;
    connectElement.disabled = true;
    setMessage('Connecting…');

    try {
      const sessions = await request<SessionListResponse>('/api/sessions');
      renderSessions(sessions.sessions);
      selectorElement.disabled = false;
      createElement.disabled = false;
      setMessage('Connected to the device API.');
      const selected = sessions.sessions[0]?.id;
      if (selected !== undefined) {
        selectorElement.value = selected;
        void connectSession(selected);
      } else {
        clearSnapshot();
      }
    } catch (error) {
      apiToken = '';
      secretElement.value = '';
      selectorElement.disabled = true;
      createElement.disabled = true;
      setMessage(errorMessage(error));
    } finally {
      connectElement.disabled = false;
    }
  });

  selectorElement.addEventListener('change', () => {
    const selected = selectorElement.value as SessionId;
    if (selected.length > 0) void connectSession(selected);
  });

  createElement.addEventListener('click', async () => {
    createElement.disabled = true;
    try {
      const created = await request<SessionResponse>('/api/sessions', { method: 'POST' });
      const sessions = await request<SessionListResponse>('/api/sessions');
      renderSessions(sessions.sessions);
      selectorElement.value = created.session.id;
      await connectSession(created.session.id);
      setMessage('Session created.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      createElement.disabled = false;
    }
  });

  function setMessage(text: string): void {
    messageElement.textContent = text;
  }

  function renderSessions(
    sessions: readonly { readonly id: SessionId; readonly status: string }[],
  ): void {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = sessions.length === 0 ? 'No sessions yet' : 'Choose a session';
    selectorElement.replaceChildren(placeholder);
    for (const session of sessions) {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = `${session.id} · ${session.status}`;
      selectorElement.append(option);
    }
  }

  async function connectSession(id: SessionId): Promise<void> {
    activeStream?.abort();
    activeSessionId = id;
    activeStream = new AbortController();
    clearSnapshot();
    sessionIdElement.textContent = `Session ${id}`;
    void consumeEvents(id, activeStream.signal);
  }

  async function consumeEvents(id: SessionId, signal: AbortSignal): Promise<void> {
    let delay = 500;
    while (!signal.aborted && activeSessionId === id) {
      try {
        const headers = new Headers({
          Authorization: `Bearer ${apiToken}`,
          Accept: 'text/event-stream',
        });
        const lastEventId = lastEventIds.get(id);
        if (lastEventId !== undefined) headers.set('Last-Event-ID', lastEventId);
        const response = await fetch(`${apiBase()}/api/sessions/${encodeURIComponent(id)}/events`, {
          headers,
          signal,
        });
        if (!response.ok) throw await responseError(response);
        if (response.body === null) throw new Error('The event stream was not available.');
        delay = 500;

        for await (const frame of parseSseFrames(response.body)) {
          if (signal.aborted || activeSessionId !== id) return;
          const event = parseSessionEvent(frame);
          if (event === undefined) continue;
          lastEventIds.set(id, event.id);
          const snapshot = applySessionEvent(currentSnapshot, event);
          if (snapshot !== undefined) renderSnapshot(snapshot);
        }
      } catch (error) {
        if (signal.aborted) return;
        setMessage(`${errorMessage(error)} Reconnecting…`);
      }

      await wait(delay, signal);
      delay = Math.min(delay * 2, 5_000);
    }
  }

  let currentSnapshot: SessionSnapshot | undefined;

  function clearSnapshot(): void {
    currentSnapshot = undefined;
    statusElement.textContent = '—';
    taskListElement.replaceChildren(emptyTaskRow('Waiting for a session snapshot.'));
  }

  function renderSnapshot(snapshot: SessionSnapshot): void {
    currentSnapshot = snapshot;
    statusElement.textContent = snapshot.session.status;
    sessionIdElement.textContent = `Session ${snapshot.session.id} · ${snapshot.session.taskCount} task(s)`;
    taskListElement.replaceChildren(
      ...(snapshot.tasks.length === 0
        ? [emptyTaskRow('No tasks in this session.')]
        : snapshot.tasks.map(taskRow)),
    );
    setMessage('Session state is current.');
  }

  function taskRow(task: TaskSummary): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.append(
      cell(String(task.id), 'code'),
      cell(task.kind),
      cell(task.status),
      cell(formatTime(task.startedAt)),
    );
    return row;
  }

  function cell(value: string, tag: 'code' | 'span' = 'span'): HTMLTableCellElement {
    const cell = document.createElement('td');
    const content = document.createElement(tag);
    content.textContent = value;
    cell.append(content);
    return cell;
  }

  function emptyTaskRow(text: string): HTMLTableRowElement {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'muted';
    cell.textContent = text;
    row.append(cell);
    return row;
  }

  function apiBase(): string {
    const url = new URL(urlElement.value.trim());
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error('Enter an HTTP(S) API URL without credentials or query parameters.');
    }
    return url.toString().replace(/\/$/, '');
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${apiToken}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${apiBase()}${path}`, { ...init, headers });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as T;
  }

  async function responseError(response: Response): Promise<Error> {
    let body: ApiErrorBody | undefined;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // The generic status remains safe if the server did not return an API error.
    }
    return new Error(body?.error?.message ?? `The API returned status ${response.status}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}

function formatTime(timestamp: number | undefined): string {
  return timestamp === undefined ? '—' : new Date(timestamp).toLocaleString();
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
