declare const sessionIdBrand: unique symbol;

export type SessionId = string & { readonly [sessionIdBrand]: true };

export interface SessionSummary {
  readonly id: SessionId;
  readonly status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
}
