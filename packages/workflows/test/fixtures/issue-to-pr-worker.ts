import { readFile, writeFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineExtension, type TaskId } from '@earendil-works/pi-durable';
import type {
  GitHubIssue,
  GitHubIssueToPrAdapter,
  PullRequestSummary,
} from '@factory/integrations';
import { openAgentHarness } from '@factory/agent-runtime';
import {
  createIssueToPrTask,
  decideIssueToPrApproval,
  startIssueToPrRun,
} from '../../src/issue-to-pr.js';

type RemoteState = {
  pullRequests: Record<string, PullRequestSummary>;
  lookupCalls: number;
  createCalls: number;
  effects: number;
};

const [mode, databasePath, remotePath, taskIdArg] = process.argv.slice(2);
if (mode !== 'before-write' && mode !== 'after-write' && mode !== 'resume') {
  throw new Error(`Unknown worker mode: ${mode}`);
}
if (databasePath === undefined || remotePath === undefined) {
  throw new Error('Worker paths are required.');
}

const context = BACKGROUND_CONTEXT;
const github: GitHubIssueToPrAdapter = {
  async getIssue(number): Promise<GitHubIssue> {
    return {
      number,
      title: 'Add a health check',
      body: 'Add a health endpoint.',
      state: 'open',
      url: `https://github.com/factory-owner/factory-repo/issues/${number}`,
      labels: ['factory/approved'],
    };
  },
  async createPullRequestOnce(input) {
    const state = JSON.parse(await readFile(remotePath, 'utf8')) as RemoteState;
    state.lookupCalls += 1;
    const existing = state.pullRequests[input.operationKey];
    if (existing !== undefined) {
      await writeFile(remotePath, JSON.stringify(state));
      return existing;
    }

    if (mode === 'before-write') process.exit(72);

    const pullRequest: PullRequestSummary = {
      number: 17,
      url: 'https://github.com/factory-owner/factory-repo/pull/17',
      head: input.head,
      base: input.base ?? 'main',
      state: 'open',
      draft: true,
    };
    state.createCalls += 1;
    state.effects += 1;
    state.pullRequests[input.operationKey] = pullRequest;
    await writeFile(remotePath, JSON.stringify(state));

    if (mode === 'after-write') process.exit(73);
    return pullRequest;
  },
};
const task = createIssueToPrTask({
  github,
  executor: {
    async prepare(issue, operationKey) {
      return {
        head: `factory/issue-${issue.number}-${operationKey}`,
        title: issue.title,
        body: 'Prepared change summary.',
        base: 'main',
      };
    },
  },
  requiredLabel: 'factory/approved',
});
const registry = createRegistry();
registry.install(defineExtension({ name: 'factory.test.issue-to-pr', tasks: [task] }));
const harness = await openAgentHarness(databasePath, { models: createModels(), registry }, context);

try {
  if (mode !== 'resume') {
    const root = await harness.root(context);
    const taskId = await root.commit((tx) => startIssueToPrRun(tx, task, 42), context);
    await new Promise<void>((resolve) => process.stdout.write(`TASK:${taskId}\n`, resolve));
    harness.resume();
    await waitForApprovalPhase(harness, taskId);
    await root.commit((tx) => decideIssueToPrApproval(tx, taskId, 'approved'), context);
    await harness.waitForIdle(context);
  } else {
    if (taskIdArg === undefined) throw new Error('Task ID is required when resuming.');
    harness.resume();
    await harness.waitForIdle(context);
    const result = await harness.getTask(taskIdArg as TaskId, context);
    if (result === undefined) throw new Error(`Task ${taskIdArg} disappeared during recovery.`);
    console.log(`RESULT:${JSON.stringify(result.state.outcome)}`);
  }
} finally {
  await harness.close(context);
}

async function waitForApprovalPhase(
  currentHarness: Awaited<ReturnType<typeof openAgentHarness>>,
  taskId: TaskId,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const record = await currentHarness.getTask(taskId, context);
    if (
      record?.state.status === 'running' &&
      checkpointPhase(record.state.checkpoint) === 'approval'
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Issue-to-PR task did not reach approval phase.');
}

function checkpointPhase(checkpoint: unknown): string | undefined {
  if (typeof checkpoint !== 'object' || checkpoint === null || !('phase' in checkpoint)) {
    return undefined;
  }
  return typeof checkpoint.phase === 'string' ? checkpoint.phase : undefined;
}
