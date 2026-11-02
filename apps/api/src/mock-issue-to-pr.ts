import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineExtension, type HarnessOptions } from '@earendil-works/pi-durable';
import type {
  GitHubIssue,
  GitHubIssueToPrAdapter,
  PullRequestSummary,
} from '@factory/integrations';
import { createIssueToPrTask, type IssueWorkspaceExecutor } from '@factory/workflows';
import { createIssueToPrService, type IssueToPrService } from './issue-to-pr-service.js';

const REQUIRED_LABEL = 'factory/approved';

export interface MockIssueToPrRuntime {
  readonly harnessOptions: HarnessOptions;
  readonly issueToPrService: IssueToPrService;
}

/** Build local mock integrations. The API server supplies the Docker-backed workspace executor. */
export function createMockIssueToPrRuntime(
  executor?: IssueWorkspaceExecutor,
): MockIssueToPrRuntime {
  const issues = new Map<number, GitHubIssue>([
    [
      42,
      {
        number: 42,
        title: 'Add a health check',
        body: 'Mock issue for the local issue-to-PR flow.',
        state: 'open',
        url: 'https://github.com/factory-mock/demo/issues/42',
        labels: [REQUIRED_LABEL],
      },
    ],
    [
      43,
      {
        number: 43,
        title: 'Issue missing approval label',
        body: null,
        state: 'open',
        url: 'https://github.com/factory-mock/demo/issues/43',
        labels: [],
      },
    ],
    [
      44,
      {
        number: 44,
        title: 'Closed issue',
        body: null,
        state: 'closed',
        url: 'https://github.com/factory-mock/demo/issues/44',
        labels: [REQUIRED_LABEL],
      },
    ],
  ]);
  const pullRequests = new Map<string, PullRequestSummary>();
  const github: GitHubIssueToPrAdapter = {
    async getIssue(number) {
      const issue = issues.get(number);
      if (issue === undefined) throw new Error('Mock GitHub issue was not found.');
      return issue;
    },
    async createPullRequestOnce(input) {
      const existing = pullRequests.get(input.operationKey);
      if (existing !== undefined) return existing;

      const number = pullRequests.size + 1;
      const pullRequest: PullRequestSummary = {
        number,
        url: `https://github.com/factory-mock/demo/pull/${number}`,
        head: input.head,
        base: input.base ?? 'main',
        state: 'open',
        draft: true,
      };
      pullRequests.set(input.operationKey, pullRequest);
      return pullRequest;
    },
  };
  const task = createIssueToPrTask({
    github,
    executor: executor ?? {
      async prepare(issue, operationKey, signal) {
        if (signal.aborted) throw new Error('Mock execution was cancelled.');
        return {
          head: `factory/issue-${issue.number}-${operationKey.slice(0, 8)}`,
          base: 'main',
          title: `[Mock] ${issue.title}`,
          body: 'Mock executor prepared this draft. No repository files changed.',
        };
      },
    },
    requiredLabel: REQUIRED_LABEL,
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'factory.mock.issue-to-pr', tasks: [task] }));

  return {
    harnessOptions: { models: createModels(), registry },
    issueToPrService: createIssueToPrService(task),
  };
}
