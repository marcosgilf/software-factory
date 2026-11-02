import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { TaskId as PiTaskId } from '@earendil-works/pi-durable';
import type { CatalogSession } from '@factory/agent-runtime';
import type {
  IssueToPrApprovalDecision,
  IssueToPrProgressResponse,
  TaskSummary,
} from '@factory/contracts';
import {
  decideIssueToPrApproval,
  IssueToPrApprovalDoc,
  IssueToPrApprovalError,
  ISSUE_TO_PR_TASK_NAME,
  startIssueToPrRun,
  type IssueToPrTask,
} from '@factory/workflows';

export class IssueToPrTaskNotFoundError extends Error {}
export class IssueToPrApprovalConflictError extends Error {}

export interface IssueToPrService {
  start(session: CatalogSession, issueNumber: number): Promise<TaskSummary>;
  progress(session: CatalogSession, taskId: string): Promise<IssueToPrProgressResponse>;
  decide(
    session: CatalogSession,
    taskId: string,
    decision: IssueToPrApprovalDecision,
  ): Promise<TaskSummary>;
}

export function createIssueToPrService(task: IssueToPrTask): IssueToPrService {
  return {
    async start(session, issueNumber) {
      const root = await session.harness.root(BACKGROUND_CONTEXT);
      const id = await root.commit(
        (tx) => startIssueToPrRun(tx, task, issueNumber),
        BACKGROUND_CONTEXT,
      );
      session.harness.resume();
      const summary = await session.getTask(String(id));
      if (summary === undefined) throw new Error('Issue-to-PR task disappeared after creation.');
      return summary;
    },
    async progress(session, taskId) {
      const id = parseTaskId(taskId);
      const record = await session.harness.getTask(id, BACKGROUND_CONTEXT);
      if (record === undefined || record.kind !== ISSUE_TO_PR_TASK_NAME) {
        throw new IssueToPrTaskNotFoundError('Issue-to-PR task was not found.');
      }

      if (record.state.status === 'completing' || record.state.status === 'terminal') {
        const outcome = record.state.outcome;
        if (outcome.status === 'aborted') return { status: 'aborted' };
        if (outcome.status !== 'completed') return { status: 'failed' };
        const result = asRecord(outcome.result);
        if (result?.decision === 'not_eligible' || result?.decision === 'approval_rejected') {
          return { status: 'rejected' };
        }
        if (result?.decision === 'pull_request_created') {
          const pullRequest = asRecord(result.pullRequest);
          if (typeof pullRequest?.url === 'string') {
            return { status: 'completed', pullRequestUrl: pullRequest.url };
          }
        }
        return { status: 'completed' };
      }

      const phase = checkpointPhase(record.state);
      if (phase !== 'approval' && phase !== 'create_pull_request') return { status: 'preparing' };
      const approval = await session.harness.snapshot(IssueToPrApprovalDoc, id, BACKGROUND_CONTEXT);
      return { status: approval?.status ?? 'preparing' };
    },
    async decide(session, taskId, decision) {
      const id = parseTaskId(taskId);
      const record = await session.harness.getTask(id, BACKGROUND_CONTEXT);
      if (record === undefined || record.kind !== ISSUE_TO_PR_TASK_NAME) {
        throw new IssueToPrTaskNotFoundError('Issue-to-PR task was not found.');
      }
      try {
        await session.harness.commit(
          (tx) => decideIssueToPrApproval(tx, id, decision),
          BACKGROUND_CONTEXT,
        );
      } catch (error) {
        if (error instanceof IssueToPrApprovalError) {
          throw new IssueToPrApprovalConflictError(error.message);
        }
        throw error;
      }
      const summary = await session.getTask(String(id));
      if (summary === undefined) {
        throw new IssueToPrTaskNotFoundError('Issue-to-PR task was not found.');
      }
      return summary;
    },
  };
}

function parseTaskId(value: string): PiTaskId {
  if (!/^[1-9][0-9]*$/.test(value)) throw new IssueToPrTaskNotFoundError('Task was not found.');
  const numericId = Number(value);
  if (!Number.isSafeInteger(numericId)) throw new IssueToPrTaskNotFoundError('Task was not found.');
  return numericId as PiTaskId;
}

function checkpointPhase(state: {
  readonly status: string;
  readonly checkpoint?: unknown;
}): string | undefined {
  if (state.checkpoint === null || typeof state.checkpoint !== 'object') return undefined;
  const checkpoint = state.checkpoint as { readonly phase?: unknown };
  return typeof checkpoint.phase === 'string' ? checkpoint.phase : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
