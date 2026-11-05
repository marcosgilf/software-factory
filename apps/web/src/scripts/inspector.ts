import type {
  IssueToPrApprovalDecision,
  IssueToPrProgressResponse,
  SessionId,
  SessionListResponse,
  SessionResponse,
  SessionSnapshot,
  TaskResponse,
  TaskSummary,
} from '@factory/contracts';
import {
  applySessionEvent,
  parseSessionEvent,
  parseSseFrames,
  reconnectSchedule,
  resolveApiBase,
} from '../lib/inspector.js';

interface ApiErrorBody {
  readonly error?: { readonly message?: string };
}

const ISSUE_TO_PR_TASK_KIND = 'factory.workflow.issue-to-pr';

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
  const workflowForm = document.querySelector<HTMLFormElement>('#issue-to-pr-form');
  const issueNumberInput = document.querySelector<HTMLInputElement>('#issue-number');
  const startWorkflowButton = document.querySelector<HTMLButtonElement>('#start-issue-to-pr');
  const workflowProgressLabel = document.querySelector<HTMLLabelElement>(
    '#workflow-progress-label',
  );
  const workflowProgress = document.querySelector<HTMLProgressElement>('#workflow-progress');
  const workflowStatus = document.querySelector<HTMLElement>('#workflow-status');
  const workflowActions = document.querySelector<HTMLElement>('#workflow-actions');
  const approveWorkflowButton = document.querySelector<HTMLButtonElement>('#approve-issue-to-pr');
  const rejectWorkflowButton = document.querySelector<HTMLButtonElement>('#reject-issue-to-pr');
  const workflowResult = document.querySelector<HTMLElement>('#workflow-result');
  const workflowPullRequestUrl = document.querySelector<HTMLElement>('#workflow-pr-url');

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
    taskList === null ||
    workflowForm === null ||
    issueNumberInput === null ||
    startWorkflowButton === null ||
    workflowProgressLabel === null ||
    workflowProgress === null ||
    workflowStatus === null ||
    workflowActions === null ||
    approveWorkflowButton === null ||
    rejectWorkflowButton === null ||
    workflowResult === null ||
    workflowPullRequestUrl === null
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
  const workflowFormElement = workflowForm as HTMLFormElement;
  const issueNumberElement = issueNumberInput as HTMLInputElement;
  const startWorkflowElement = startWorkflowButton as HTMLButtonElement;
  const workflowProgressLabelElement = workflowProgressLabel as HTMLLabelElement;
  const workflowProgressElement = workflowProgress as HTMLProgressElement;
  const workflowStatusElement = workflowStatus as HTMLElement;
  const workflowActionsElement = workflowActions as HTMLElement;
  const approveWorkflowElement = approveWorkflowButton as HTMLButtonElement;
  const rejectWorkflowElement = rejectWorkflowButton as HTMLButtonElement;
  const workflowResultElement = workflowResult as HTMLElement;
  const workflowPullRequestUrlElement = workflowPullRequestUrl as HTMLElement;

  let apiToken = '';
  let activeSessionId: SessionId | undefined;
  let activeStream: AbortController | undefined;
  let workflowPoll: AbortController | undefined;
  let activeWorkflowSessionId: SessionId | undefined;
  let activeWorkflowTaskId: number | undefined;
  let workflowIsTerminal = true;
  let workflowDecisionInFlight = false;
  const lastEventIds = new Map<SessionId, string>();

  formElement.addEventListener('submit', async (event) => {
    event.preventDefault();
    activeStream?.abort();
    workflowPoll?.abort();
    activeSessionId = undefined;
    resetWorkflow('Connecting…');
    clearSnapshot();
    selectorElement.disabled = true;
    createElement.disabled = true;
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
        resetWorkflow('Create or choose a session to start an issue workflow.');
      }
    } catch (error) {
      apiToken = '';
      secretElement.value = '';
      selectorElement.disabled = true;
      createElement.disabled = true;
      resetWorkflow('Connect to the device API and choose a session to start.');
      setMessage(errorMessage(error));
    } finally {
      connectElement.disabled = false;
    }
  });

  selectorElement.addEventListener('change', () => {
    const selected = selectorElement.value as SessionId;
    if (selected.length > 0) {
      void connectSession(selected);
    } else {
      activeStream?.abort();
      activeSessionId = undefined;
      clearSnapshot();
      resetWorkflow('Choose a session to start an issue workflow.');
    }
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

  issueNumberElement.addEventListener('input', () => issueNumberElement.setCustomValidity(''));
  workflowFormElement.addEventListener('submit', async (event) => {
    event.preventDefault();
    const sessionId = activeSessionId;
    const issueNumber = Number(issueNumberElement.value);
    if (sessionId === undefined) {
      setWorkflowStatus('Choose a session before starting an issue workflow.');
      return;
    }
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      issueNumberElement.setCustomValidity('Enter a positive whole GitHub issue number.');
      issueNumberElement.reportValidity();
      return;
    }
    if (!workflowIsTerminal) {
      setWorkflowStatus('Wait for the current issue workflow to finish first.');
      return;
    }

    issueNumberElement.setCustomValidity('');
    startWorkflowElement.disabled = true;
    setWorkflowStatus('Starting issue workflow…');
    try {
      const started = await request<TaskResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/workflows/issue-to-pr`,
        { method: 'POST', body: JSON.stringify({ issueNumber }) },
      );
      trackWorkflowTask(
        sessionId,
        started.task.id,
        'Workflow started. Checking issue eligibility…',
      );
    } catch (error) {
      workflowIsTerminal = true;
      startWorkflowElement.disabled = activeSessionId === undefined;
      setWorkflowStatus(errorMessage(error));
    }
  });

  approveWorkflowElement.addEventListener('click', () => {
    void decideWorkflow('approved');
  });
  rejectWorkflowElement.addEventListener('click', () => {
    void decideWorkflow('rejected');
  });

  function setMessage(text: string): void {
    messageElement.textContent = text;
  }

  function setWorkflowStatus(text: string): void {
    if (workflowStatusElement.textContent !== text) workflowStatusElement.textContent = text;
  }

  function resetWorkflow(status: string): void {
    workflowPoll?.abort();
    workflowPoll = undefined;
    activeWorkflowSessionId = undefined;
    activeWorkflowTaskId = undefined;
    workflowIsTerminal = true;
    workflowDecisionInFlight = false;
    startWorkflowElement.disabled = activeSessionId === undefined;
    workflowProgressLabelElement.hidden = true;
    workflowProgressElement.hidden = true;
    workflowActionsElement.hidden = true;
    approveWorkflowElement.disabled = false;
    rejectWorkflowElement.disabled = false;
    workflowResultElement.hidden = true;
    workflowPullRequestUrlElement.textContent = '';
    setWorkflowStatus(status);
  }

  function trackWorkflowTask(sessionId: SessionId, taskId: number, status: string): void {
    if (activeWorkflowSessionId === sessionId && activeWorkflowTaskId === taskId) return;
    workflowPoll?.abort();
    activeWorkflowSessionId = sessionId;
    activeWorkflowTaskId = taskId;
    workflowIsTerminal = false;
    workflowDecisionInFlight = false;
    startWorkflowElement.disabled = true;
    workflowActionsElement.hidden = true;
    workflowResultElement.hidden = true;
    setWorkflowStatus(status);
    startWorkflowProgress(sessionId, String(taskId));
  }

  function syncWorkflow(snapshot: SessionSnapshot): void {
    const latest = [...snapshot.tasks]
      .reverse()
      .find((task) => task.kind === ISSUE_TO_PR_TASK_KIND);
    if (latest === undefined) return;
    trackWorkflowTask(snapshot.session.id, latest.id, 'Restoring issue workflow status…');
  }

  function startWorkflowProgress(sessionId: SessionId, taskId: string): void {
    workflowPoll?.abort();
    const controller = new AbortController();
    workflowPoll = controller;
    void pollWorkflowProgress(sessionId, taskId, controller.signal);
  }

  async function pollWorkflowProgress(
    sessionId: SessionId,
    taskId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let delay = 1_000;
    while (
      !signal.aborted &&
      activeSessionId === sessionId &&
      activeWorkflowSessionId === sessionId &&
      String(activeWorkflowTaskId) === taskId
    ) {
      try {
        const progress = await request<IssueToPrProgressResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/approval`,
          { signal },
        );
        if (signal.aborted) return;
        renderWorkflowProgress(progress);
        if (workflowIsTerminal) return;
      } catch (error) {
        if (signal.aborted) return;
        setWorkflowStatus(`${errorMessage(error)} Rechecking workflow…`);
      }
      await wait(delay, signal);
      delay = Math.min(delay * 2, 5_000);
    }
  }

  function renderWorkflowProgress(progress: IssueToPrProgressResponse): void {
    workflowIsTerminal = ['completed', 'rejected', 'failed', 'aborted'].includes(progress.status);
    workflowDecisionInFlight = progress.status === 'pending' && workflowDecisionInFlight;
    startWorkflowElement.disabled = activeSessionId === undefined || !workflowIsTerminal;
    const isWorking = progress.status === 'preparing' || progress.status === 'approved';
    workflowProgressLabelElement.hidden = !isWorking;
    workflowProgressElement.hidden = !isWorking;
    workflowActionsElement.hidden = progress.status !== 'pending';
    approveWorkflowElement.disabled = workflowDecisionInFlight;
    rejectWorkflowElement.disabled = workflowDecisionInFlight;
    workflowResultElement.hidden = progress.pullRequestUrl === undefined;
    workflowPullRequestUrlElement.textContent = progress.pullRequestUrl ?? '';

    const messages: Record<IssueToPrProgressResponse['status'], string> = {
      preparing: 'Checking issue and preparing work…',
      pending: workflowDecisionInFlight
        ? 'Decision submitted; waiting for workflow update…'
        : 'Waiting for your approval.',
      approved: 'Approval recorded; draft PR creation is in progress…',
      rejected: 'Issue workflow rejected.',
      completed: 'Draft PR created.',
      failed: 'Workflow failed before completion. No PR was reported.',
      aborted: 'Issue workflow cancelled.',
    };
    setWorkflowStatus(messages[progress.status]);
  }

  async function decideWorkflow(decision: IssueToPrApprovalDecision): Promise<void> {
    const sessionId = activeWorkflowSessionId;
    const taskId = activeWorkflowTaskId;
    if (sessionId === undefined || taskId === undefined || workflowDecisionInFlight) return;

    workflowDecisionInFlight = true;
    approveWorkflowElement.disabled = true;
    rejectWorkflowElement.disabled = true;
    setWorkflowStatus(decision === 'approved' ? 'Approval submitted…' : 'Rejection submitted…');
    try {
      await request<TaskResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${taskId}/approval`,
        { method: 'POST', body: JSON.stringify({ decision }) },
      );
    } catch (error) {
      workflowDecisionInFlight = false;
      approveWorkflowElement.disabled = false;
      rejectWorkflowElement.disabled = false;
      setWorkflowStatus(errorMessage(error));
    }
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
    resetWorkflow('Loading issue workflow state…');
    activeSessionId = id;
    startWorkflowElement.disabled = false;
    lastEventIds.delete(id);
    activeStream = new AbortController();
    clearSnapshot();
    sessionIdElement.textContent = `Session ${id}`;
    void consumeEvents(id, activeStream.signal);
  }

  async function consumeEvents(id: SessionId, signal: AbortSignal): Promise<void> {
    let delay = 500;
    while (!signal.aborted && activeSessionId === id) {
      let connectedAt: number | undefined;
      try {
        const headers = new Headers({
          Authorization: `Bearer ${apiToken}`,
          Accept: 'text/event-stream',
        });
        const lastEventId = lastEventIds.get(id);
        if (lastEventId !== undefined) headers.set('Last-Event-ID', lastEventId);
        const response = await fetch(
          `${resolveApiBase(urlElement.value)}/api/sessions/${encodeURIComponent(id)}/events`,
          { headers, signal },
        );
        if (!response.ok) throw await responseError(response);
        if (response.body === null) throw new Error('The event stream was not available.');
        connectedAt = Date.now();
        setMessage('Live updates connected; waiting for updates.');

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

      const schedule = reconnectSchedule(
        delay,
        connectedAt === undefined ? 0 : Date.now() - connectedAt,
      );
      await wait(schedule.waitMs, signal);
      delay = schedule.nextDelayMs;
    }
  }

  let currentSnapshot: SessionSnapshot | undefined;

  function clearSnapshot(): void {
    currentSnapshot = undefined;
    statusElement.textContent = '—';
    sessionIdElement.textContent = 'Choose a session to inspect its durable task summaries.';
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
    syncWorkflow(snapshot);
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

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${apiToken}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${resolveApiBase(urlElement.value)}${path}`, {
      ...init,
      headers,
    });
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
