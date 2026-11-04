import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineExtension, type HarnessOptions } from '@earendil-works/pi-durable';
import {
  GitHubIntegration,
  type GitHubBranchPublisher,
  type GitHubRepository,
} from '@factory/integrations';
import { createIssueToPrService, type IssueToPrService } from './issue-to-pr-service.js';
import { DockerMockIssueWorkspaceExecutor } from './docker-mock-issue-workspace-executor.js';
import { createMockIssueToPrRuntime } from './mock-issue-to-pr.js';
import { createIssueToPrTask, type IssueWorkspaceExecutor } from '@factory/workflows';

const REQUIRED_LABEL = 'factory/approved';

export interface IssueToPrRuntime {
  readonly harnessOptions: HarnessOptions;
  readonly issueToPrService: IssueToPrService;
  readonly github?: GitHubIntegration;
  readonly branchPublisher?: GitHubBranchPublisher;
}

export interface GitHubRuntimeConfig {
  readonly token: string;
  readonly repository: GitHubRepository;
}

/** Configure mock or backend-only GitHub adapters. Real mode has no coding executor in PR A. */
export function createIssueToPrRuntime(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): IssueToPrRuntime | undefined {
  const mode = env.FACTORY_ISSUE_TO_PR_MODE;
  if (mode === undefined) return undefined;
  if (mode === 'mock') {
    return createMockIssueToPrRuntime(new DockerMockIssueWorkspaceExecutor());
  }
  if (mode !== 'github') {
    throw new Error('FACTORY_ISSUE_TO_PR_MODE must be mock or github.');
  }

  const config = parseGitHubRuntimeConfig(env);
  const github = new GitHubIntegration({
    ...config,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  const executor: IssueWorkspaceExecutor = {
    async prepare() {
      throw new Error('Real workspace execution is not configured; no branch or PR was published.');
    },
  };
  const task = createIssueToPrTask({ github, executor, requiredLabel: REQUIRED_LABEL });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'factory.github.issue-to-pr', tasks: [task] }));

  return {
    harnessOptions: { models: createModels(), registry },
    issueToPrService: createIssueToPrService(task),
    github,
    branchPublisher: github,
  };
}

export function parseGitHubRuntimeConfig(env: NodeJS.ProcessEnv): GitHubRuntimeConfig {
  const token = env.FACTORY_GITHUB_TOKEN;
  const repositoryValue = env.FACTORY_GITHUB_REPOSITORY;
  const defaultBranch = env.FACTORY_GITHUB_DEFAULT_BRANCH;
  const allowlistValue = env.FACTORY_GITHUB_ALLOWED_REPOSITORIES;
  if (
    token === undefined ||
    token.length === 0 ||
    repositoryValue === undefined ||
    defaultBranch === undefined ||
    allowlistValue === undefined
  ) {
    throw new Error(
      'GitHub mode requires token, repository, default branch, and repository allowlist.',
    );
  }

  const repository = parseRepository(repositoryValue, defaultBranch);
  const allowlist = allowlistValue.split(',').map((value) => parseRepositorySlug(value.trim()));
  const allowlistKeys = allowlist.map(repositoryKey);
  if (new Set(allowlistKeys).size !== allowlistKeys.length) {
    throw new Error('GitHub repository allowlist contains duplicates.');
  }
  if (!allowlistKeys.includes(repositoryKey(repository))) {
    throw new Error('Configured GitHub repository is not in the repository allowlist.');
  }
  return { token, repository };
}

function parseRepository(value: string, defaultBranch: string): GitHubRepository {
  return { ...parseRepositorySlug(value), defaultBranch };
}

function parseRepositorySlug(value: string): Pick<GitHubRepository, 'owner' | 'name'> {
  const parts = value.split('/');
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9-]+$/.test(parts[0] ?? '') ||
    !/^[A-Za-z0-9._-]+$/.test(parts[1] ?? '')
  ) {
    throw new Error('GitHub repository configuration is invalid.');
  }
  return { owner: parts[0]!, name: parts[1]! };
}

function repositoryKey(repository: Pick<GitHubRepository, 'owner' | 'name'>): string {
  return `${repository.owner}/${repository.name}`.toLowerCase();
}
