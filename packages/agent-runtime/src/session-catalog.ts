import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  createRegistry,
  type HarnessOptions,
  type TaskId as PiTaskId,
} from '@earendil-works/pi-durable';
import type {
  SessionId,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  TaskId,
  TaskStatus,
  TaskSummary,
} from '@factory/contracts';
import { openAgentHarness, type AgentHarness } from './harness.js';

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'running',
  'waiting',
  'sleeping',
  'completing',
]);
const FAILED_TASK_STATUSES = new Set<TaskStatus>(['failed', 'faulted', 'orphaned']);
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CatalogSession {
  readonly id: SessionId;
  /** Server-side runtime handles. Never serialize these values to a client. */
  readonly harness: AgentHarness;
  getSnapshot(): Promise<SessionSnapshot>;
  getTask(id: string): Promise<TaskSummary | undefined>;
  observe(listener: (snapshot: SessionSnapshot) => void): () => void;
  close(): Promise<void>;
}

export interface SessionCatalog {
  start(): Promise<void>;
  close(): Promise<void>;
  listSessions(): Promise<readonly SessionSummary[]>;
  createSession(): Promise<CatalogSession>;
  getSession(id: SessionId): CatalogSession | undefined;
}

export interface SessionCatalogOptions {
  readonly directory?: string;
  readonly harnessOptions?: HarnessOptions;
}

/** Owns one SQLite-backed Pi Durable harness per session in this process. */
export class SqliteSessionCatalog implements SessionCatalog {
  readonly #directory: string;
  readonly #harnessOptions: HarnessOptions;
  readonly #sessions = new Map<SessionId, CatalogSession>();
  #startPromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: SessionCatalogOptions = {}) {
    this.#directory = options.directory ?? join(process.cwd(), '.factory', 'sessions');
    this.#harnessOptions = options.harnessOptions ?? {
      models: createModels(),
      registry: createRegistry(),
    };
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Session catalog is closed.'));
    if (this.#startPromise !== undefined) return this.#startPromise;

    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const existingIds = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
      .map((entry) => entry.name.slice(0, -'.sqlite'.length))
      .filter((id) => SESSION_ID_PATTERN.test(id));

    for (const id of existingIds) {
      await this.#openSession(id as SessionId, join(this.#directory, `${id}.sqlite`));
    }
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    await this.start();
    const snapshots = await Promise.all(
      [...this.#sessions.values()].map((session) => session.getSnapshot()),
    );
    return snapshots.map((snapshot) => snapshot.session).sort((a, b) => a.id.localeCompare(b.id));
  }

  async createSession(): Promise<CatalogSession> {
    await this.start();
    const id = randomUUID() as SessionId;
    const databasePath = join(this.#directory, `${id}.sqlite`);
    return this.#openSession(id, databasePath);
  }

  getSession(id: SessionId): CatalogSession | undefined {
    return this.#sessions.get(id);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#startPromise !== undefined) await this.#startPromise;
    await Promise.all([...this.#sessions.values()].map((session) => session.close()));
    this.#sessions.clear();
  }

  async #openSession(id: SessionId, databasePath: string): Promise<CatalogSession> {
    const existing = this.#sessions.get(id);
    if (existing !== undefined) return existing;

    const harness = await openAgentHarness(databasePath, this.#harnessOptions, BACKGROUND_CONTEXT);
    try {
      await harness.root(BACKGROUND_CONTEXT);
      const session = new ManagedCatalogSession(id, harness);
      // Establish a safe initial view and observer before recovered work resumes.
      await session.getSnapshot();
      harness.resume();
      await chmod(databasePath, 0o600);
      this.#sessions.set(id, session);
      return session;
    } catch (error) {
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }
}

class ManagedCatalogSession implements CatalogSession {
  readonly id: SessionId;
  readonly harness: AgentHarness;
  readonly #listeners = new Set<(snapshot: SessionSnapshot) => void>();
  readonly #unsubscribeCommits: () => void;
  #tail: Promise<void> = Promise.resolve();
  #snapshot: SessionSnapshot | undefined;
  #closed = false;

  constructor(id: SessionId, harness: AgentHarness) {
    this.id = id;
    this.harness = harness;
    this.#unsubscribeCommits = harness.subscribeCommits(() => {
      // Pi Durable listeners are synchronous and must not call back into the Session.
      void this.#enqueue(() => this.#refresh()).catch(() => undefined);
    });
  }

  getSnapshot(): Promise<SessionSnapshot> {
    return this.#enqueue(() => this.#refresh());
  }

  getTask(id: string): Promise<TaskSummary | undefined> {
    return this.#enqueue(async () => {
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId) || numericId <= 0) return undefined;
      const record = await this.harness.getTask(numericId as PiTaskId, BACKGROUND_CONTEXT);
      return record === undefined ? undefined : toTaskSummary(record);
    });
  }

  observe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeCommits();
    this.#listeners.clear();
    await this.harness.close(BACKGROUND_CONTEXT);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #refresh(): Promise<SessionSnapshot> {
    if (this.#closed) throw new Error('Session is closed.');
    const records = await this.harness.commit(async (tx) => {
      const all = [];
      let page = await tx.scanTasks({ order: 'ascending' }, 500);
      all.push(...page.items);
      while (page.next !== undefined) {
        page = await tx.scanTasks({ order: 'ascending' }, 500, page.next);
        all.push(...page.items);
      }
      return all;
    }, BACKGROUND_CONTEXT);
    const tasks = records.map(toTaskSummary);
    const activeTaskCount = tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length;
    const status: SessionStatus =
      activeTaskCount > 0
        ? 'running'
        : tasks.some((task) => FAILED_TASK_STATUSES.has(task.status))
          ? 'failed'
          : tasks.length > 0
            ? 'completed'
            : 'idle';
    const nextView = {
      session: { id: this.id, status, taskCount: tasks.length, activeTaskCount },
      tasks,
    };

    if (this.#snapshot === undefined) {
      this.#snapshot = { ...nextView, revision: 0 };
      return this.#snapshot;
    }

    if (
      JSON.stringify(nextView) ===
      JSON.stringify({
        session: this.#snapshot.session,
        tasks: this.#snapshot.tasks,
      })
    ) {
      return this.#snapshot;
    }

    this.#snapshot = { ...nextView, revision: this.#snapshot.revision + 1 };
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#snapshot);
      } catch {
        // A disconnected observer cannot interfere with durable task execution.
      }
    }
    return this.#snapshot;
  }
}

function toTaskSummary(record: {
  readonly id: number;
  readonly kind: string;
  readonly state: { readonly status: string; readonly outcome?: { readonly status?: string } };
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
}): TaskSummary {
  const status =
    record.state.status === 'terminal'
      ? record.state.outcome?.status === 'faulted'
        ? 'faulted'
        : record.state.outcome?.status
      : record.state.status;
  const safeStatus = isTaskStatus(status) ? status : 'failed';

  return {
    id: record.id as unknown as TaskId,
    kind: record.kind,
    status: safeStatus,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
  };
}

function isTaskStatus(value: string | undefined): value is TaskStatus {
  return (
    value !== undefined &&
    [
      'pending',
      'running',
      'waiting',
      'sleeping',
      'completing',
      'completed',
      'failed',
      'aborted',
      'orphaned',
      'faulted',
    ].includes(value)
  );
}
