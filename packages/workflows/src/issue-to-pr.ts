import { randomUUID } from 'node:crypto';
import type { Context } from '@earendil-works/chord';
import {
  defineDoc,
  defineTask,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from '@earendil-works/pi-durable';
import type {
  CreatePullRequestInput,
  GitHubIssue,
  GitHubIssueToPrAdapter,
  PullRequestSummary,
} from '@factory/integrations';

export const ISSUE_TO_PR_TASK_NAME = 'factory.workflow.issue-to-pr';

export class IssueToPrApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueToPrApprovalError';
  }
}

export type IssueToPrApprovalStatus = 'pending' | 'approved' | 'rejected';

export const IssueToPrApprovalDoc = defineDoc<{
  status: IssueToPrApprovalStatus;
  decidedAt?: number;
}>({
  checkpointWhen: () => false,
  kind: 'factory.workflow.issue-to-pr.approval',
  version: 1,
  scope: 'task',
  initial: () => ({ status: 'pending' }),
});

export interface IssueToPrTaskInput {
  readonly issueNumber: number;
  readonly operationKey: string;
}

export type PreparedIssueChange = Omit<CreatePullRequestInput, 'operationKey'>;

/** Prepare code in an isolated workspace; issue fields are untrusted and no GitHub client is passed in. */
export interface IssueWorkspaceExecutor {
  prepare(
    issue: GitHubIssue,
    operationKey: string,
    signal: AbortSignal,
  ): Promise<PreparedIssueChange>;
}

export type IssueToPrTaskResult =
  | {
      readonly decision: 'not_eligible';
      readonly reason: 'issue_closed' | 'missing_required_label';
    }
  | { readonly decision: 'approval_rejected' }
  | { readonly decision: 'pull_request_created'; readonly pullRequest: PullRequestSummary };

type IssueToPrTaskState =
  | { readonly phase: 'inspect'; readonly issueNumber: number; readonly operationKey: string }
  | {
      readonly phase: 'prepare';
      readonly issue: GitHubIssue;
      readonly operationKey: string;
    }
  | {
      readonly phase: 'approval';
      readonly operationKey: string;
      readonly prepared: PreparedIssueChange;
    }
  | {
      readonly phase: 'create_pull_request';
      readonly operationKey: string;
      readonly prepared: PreparedIssueChange;
    };

export type IssueToPrTask = Task<
  IssueToPrTaskInput,
  IssueToPrTaskState,
  IssueToPrTaskResult,
  object
>;

export interface IssueToPrWorkflowOptions {
  readonly github: GitHubIssueToPrAdapter;
  readonly executor: IssueWorkspaceExecutor;
  readonly requiredLabel: string;
}

/** Build backend task. `executor` receives no GitHub client or credential. */
export function createIssueToPrTask(options: IssueToPrWorkflowOptions): IssueToPrTask {
  if (options.requiredLabel.trim().length === 0) {
    throw new Error('An issue eligibility label is required.');
  }

  return defineTask<IssueToPrTaskInput, IssueToPrTaskState, IssueToPrTaskResult>({
    name: ISSUE_TO_PR_TASK_NAME,
    version: 1,
    initial: (input) => ({
      phase: 'inspect',
      issueNumber: input.issueNumber,
      operationKey: input.operationKey,
    }),
    phases: {
      inspect: async (task, runtime, context) => {
        const issue = await options.github.getIssue(task.state.checkpoint.issueNumber);
        const reason =
          issue.state !== 'open'
            ? 'issue_closed'
            : issue.labels.includes(options.requiredLabel)
              ? undefined
              : 'missing_required_label';
        if (reason !== undefined) {
          await runtime.commit(async (tx) => {
            const approval = await tx.doc(IssueToPrApprovalDoc, task.id);
            approval.status = 'rejected';
            approval.decidedAt = runtime.now();
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: { decision: 'not_eligible', reason } },
            };
          }, context);
          return;
        }
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: {
              phase: 'prepare',
              issue,
              operationKey: task.state.checkpoint.operationKey,
            },
          }),
          context,
        );
      },
      prepare: async (task, runtime, context) => {
        const prepared = await options.executor.prepare(
          task.state.checkpoint.issue,
          task.state.checkpoint.operationKey,
          runtime.signal,
        );
        await runtime.commit(async (tx) => {
          const approval = await tx.doc(IssueToPrApprovalDoc, task.id);
          if (approval.status !== 'pending') {
            throw new Error('Issue-to-PR approval changed before review.');
          }
          return {
            status: 'running',
            checkpoint: {
              phase: 'approval',
              operationKey: task.state.checkpoint.operationKey,
              prepared,
            },
          };
        }, context);
      },
      approval: async (task, runtime, context) => {
        const decision = await waitForApproval(task.id, runtime, context);
        if (decision === 'rejected') {
          await complete(runtime, { decision: 'approval_rejected' }, context);
          return;
        }
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: {
              phase: 'create_pull_request',
              operationKey: task.state.checkpoint.operationKey,
              prepared: task.state.checkpoint.prepared,
            },
          }),
          context,
        );
      },
      create_pull_request: async (task, runtime, context) => {
        const pullRequest = await options.github.createPullRequestOnce({
          ...task.state.checkpoint.prepared,
          operationKey: task.state.checkpoint.operationKey,
        });
        await complete(runtime, { decision: 'pull_request_created', pullRequest }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({
          status: 'terminal',
          outcome: { status: 'aborted', reason: 'Issue-to-PR workflow was cancelled.' },
        }),
        context,
      );
    },
  });
}

/** Create workflow task and its pending approval record in one durable commit. */
export async function startIssueToPrRun(
  tx: Tx,
  task: IssueToPrTask,
  issueNumber: number,
): Promise<TaskId<IssueToPrTaskResult>> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('GitHub issue number must be a positive safe integer.');
  }
  const taskId = await tx.createTask(
    task,
    { issueNumber, operationKey: randomUUID() },
    { ownership: { kind: 'conversation' } },
  );
  await tx.doc(IssueToPrApprovalDoc, taskId);
  return taskId;
}

/** Approve or reject only when matching workflow task is waiting for human review. */
export async function decideIssueToPrApproval(
  tx: Tx,
  taskId: TaskId,
  decision: Exclude<IssueToPrApprovalStatus, 'pending'>,
): Promise<void> {
  const task = await tx.task(taskId);
  const checkpoint = task?.state.status === 'running' ? task.state.checkpoint : undefined;
  if (task?.kind !== ISSUE_TO_PR_TASK_NAME || checkpointPhase(checkpoint) !== 'approval') {
    throw new IssueToPrApprovalError('Issue-to-PR task is not awaiting approval.');
  }

  const approval = await tx.doc(IssueToPrApprovalDoc, taskId);
  if (approval.status !== 'pending') {
    throw new IssueToPrApprovalError('Issue-to-PR approval is already decided.');
  }
  approval.status = decision;
  approval.decidedAt = Date.now();
}

async function waitForApproval(
  taskId: TaskId<IssueToPrTaskResult>,
  runtime: TaskRuntime<IssueToPrTaskInput, IssueToPrTaskState, IssueToPrTaskResult, object>,
  context: Context,
): Promise<IssueToPrApprovalStatus> {
  const watch = await runtime.watchDoc(IssueToPrApprovalDoc, taskId, context);
  if (watch === undefined || watch.value === null) {
    throw new Error('Issue-to-PR approval record is missing.');
  }
  if (watch.value.status !== 'pending') {
    const decision = watch.value.status;
    await watch.stop();
    return decision;
  }

  let removeAbortListener: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<IssueToPrApprovalStatus>((resolve, reject) => {
        const onAbort = () => reject(new Error('Issue-to-PR approval wait was cancelled.'));
        removeAbortListener = () => runtime.signal.removeEventListener('abort', onAbort);
        if (runtime.signal.aborted) {
          onAbort();
          return;
        }
        runtime.signal.addEventListener('abort', onAbort, { once: true });
        watch.start(async (value) => {
          if (value !== null && value.status !== 'pending') resolve(value.status);
        });
      }),
      watch.closed.then((end) => {
        if (end.reason !== 'stopped' && !runtime.signal.aborted) {
          throw new Error('Issue-to-PR approval watch ended before a decision.');
        }
        return new Promise<IssueToPrApprovalStatus>(() => undefined);
      }),
    ]);
  } finally {
    removeAbortListener();
    await watch.stop();
  }
}

async function complete(
  runtime: TaskRuntime<IssueToPrTaskInput, IssueToPrTaskState, IssueToPrTaskResult, object>,
  result: IssueToPrTaskResult,
  context: Context,
): Promise<void> {
  await runtime.commit(
    () => ({ status: 'terminal', outcome: { status: 'completed', result } }),
    context,
  );
}

function checkpointPhase(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('phase' in value)) return undefined;
  return typeof value.phase === 'string' ? value.phase : undefined;
}
