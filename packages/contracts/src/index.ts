declare const sessionIdBrand: unique symbol;
declare const taskIdBrand: unique symbol;

export type SessionId = string & { readonly [sessionIdBrand]: true };
export type TaskId = number & { readonly [taskIdBrand]: true };

export const healthResponse = { status: 'ok' } as const;
export type HealthResponse = typeof healthResponse;

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed';
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'sleeping'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'orphaned'
  | 'faulted';

/** A client-safe task record. Inputs, checkpoints, outcomes and errors stay in durable storage. */
export interface TaskSummary {
  readonly id: TaskId;
  readonly kind: string;
  readonly status: TaskStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface SessionSummary {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly taskCount: number;
  readonly activeTaskCount: number;
}

export interface SessionSnapshot {
  readonly session: SessionSummary;
  readonly tasks: readonly TaskSummary[];
  /** Increments when the client-visible session or task state changes. */
  readonly revision: number;
}

export interface SessionListResponse {
  readonly sessions: readonly SessionSummary[];
}

export interface SessionResponse {
  readonly session: SessionSummary;
}

export interface TaskListResponse {
  readonly tasks: readonly TaskSummary[];
}

export interface TaskResponse {
  readonly task: TaskSummary;
}

export type SessionEventType = 'snapshot' | 'update' | 'resync';

export interface SessionEvent {
  readonly type: SessionEventType;
  readonly id: string;
  readonly snapshot: SessionSnapshot;
}

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
