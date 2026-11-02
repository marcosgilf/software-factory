import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineExtension } from '@earendil-works/pi-durable';
import type {
  GitHubIssue,
  GitHubIssueToPrAdapter,
  PullRequestSummary,
} from '@factory/integrations';
import { openAgentHarness } from '@factory/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  createIssueToPrTask,
  decideIssueToPrApproval,
  startIssueToPrRun,
  type IssueToPrTask,
} from '../src/issue-to-pr.js';

const context = BACKGROUND_CONTEXT;
const requiredLabel = 'factory/approved';
const pullRequest: PullRequestSummary = {
  number: 17,
  url: 'https://github.com/factory-owner/factory-repo/pull/17',
  head: 'factory/issue-42-change',
  base: 'main',
  state: 'open',
  draft: true,
};

describe('issue-to-PR workflow', () => {
  it('rejects closed or unlabeled issues before preparing work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-workflow-gate-'));
    const prepare = vi.fn(async () => ({ head: 'factory/unused', title: 'Unused', body: '' }));
    const createPullRequestOnce = vi.fn(async () => pullRequest);
    const issues = new Map<number, GitHubIssue>([
      [41, issue(41, 'closed', [requiredLabel])],
      [42, issue(42, 'open', [])],
    ]);
    const github: GitHubIssueToPrAdapter = {
      getIssue: async (number) => issues.get(number)!,
      createPullRequestOnce,
    };
    const task = createIssueToPrTask({
      github,
      executor: { prepare },
      requiredLabel,
    });
    const harness = await openWorkflowHarness(directory, task);

    try {
      const root = await harness.root(context);
      const taskIds = await root.commit(
        async (tx) => [
          await startIssueToPrRun(tx, task, 41),
          await startIssueToPrRun(tx, task, 42),
        ],
        context,
      );
      harness.resume();
      await Promise.all(taskIds.map((id) => harness.waitForTask(id, context)));

      const records = await Promise.all(taskIds.map((id) => harness.getTask(id, context)));
      expect(records.map((record) => terminalResult(record))).toEqual([
        { decision: 'not_eligible', reason: 'issue_closed' },
        { decision: 'not_eligible', reason: 'missing_required_label' },
      ]);
      expect(prepare).not.toHaveBeenCalled();
      expect(createPullRequestOnce).not.toHaveBeenCalled();
    } finally {
      await harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['approved', 'rejected'] as const)(
    'waits for explicit %s decision before creating a draft PR',
    async (decision) => {
      const directory = await mkdtemp(join(tmpdir(), 'factory-workflow-approval-'));
      let signalPrepared!: () => void;
      const prepared = new Promise<void>((resolve) => (signalPrepared = resolve));
      const createPullRequestOnce = vi.fn(async () => pullRequest);
      const github: GitHubIssueToPrAdapter = {
        getIssue: async (number) => issue(number, 'open', [requiredLabel]),
        createPullRequestOnce,
      };
      const task = createIssueToPrTask({
        github,
        executor: {
          prepare: async (_issue, operationKey) => {
            signalPrepared();
            return {
              head: `factory/issue-42-${operationKey}`,
              title: 'Implement approved issue',
              body: 'Prepared change summary.',
            };
          },
        },
        requiredLabel,
      });
      const harness = await openWorkflowHarness(directory, task);

      try {
        const root = await harness.root(context);
        const taskId = await root.commit((tx) => startIssueToPrRun(tx, task, 42), context);
        harness.resume();
        await prepared;
        await waitForPhase(harness, taskId, 'approval');
        expect(createPullRequestOnce).not.toHaveBeenCalled();

        await root.commit((tx) => decideIssueToPrApproval(tx, taskId, decision), context);
        await harness.waitForTask(taskId, context);
        const record = await harness.getTask(taskId, context);

        if (decision === 'approved') {
          expect(terminalResult(record)).toMatchObject({
            decision: 'pull_request_created',
            pullRequest,
          });
          expect(createPullRequestOnce).toHaveBeenCalledTimes(1);
        } else {
          expect(terminalResult(record)).toEqual({ decision: 'approval_rejected' });
          expect(createPullRequestOnce).not.toHaveBeenCalled();
        }
      } finally {
        await harness.close(context);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

async function openWorkflowHarness(directory: string, task: IssueToPrTask) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'factory.test.issue-to-pr', tasks: [task] }));
  return openAgentHarness(
    join(directory, 'session.sqlite'),
    { models: createModels(), registry },
    context,
  );
}

async function waitForPhase(
  harness: Awaited<ReturnType<typeof openAgentHarness>>,
  taskId: Awaited<ReturnType<typeof startIssueToPrRun>>,
  phase: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = await harness.getTask(taskId, context);
    if (record?.state.status === 'running' && checkpointPhase(record.state.checkpoint) === phase) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Workflow did not reach phase ${phase}.`);
}

function checkpointPhase(checkpoint: unknown): string | undefined {
  if (typeof checkpoint !== 'object' || checkpoint === null || !('phase' in checkpoint)) {
    return undefined;
  }
  return typeof checkpoint.phase === 'string' ? checkpoint.phase : undefined;
}

function terminalResult(
  record: Awaited<ReturnType<Awaited<ReturnType<typeof openAgentHarness>>['getTask']>>,
) {
  if (record?.state.status !== 'terminal') throw new Error('Workflow did not finish.');
  return record.state.outcome.result;
}

function issue(number: number, state: 'open' | 'closed', labels: readonly string[]): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: 'Untrusted issue description.',
    state,
    url: `https://github.com/factory-owner/factory-repo/issues/${number}`,
    labels,
  };
}
