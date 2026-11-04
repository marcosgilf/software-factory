declare const integrationIdBrand: unique symbol;

export type IntegrationId = string & { readonly [integrationIdBrand]: true };

export type IntegrationProvider = 'github';

export { branchNameForOperation, GitHubIntegration } from './github.js';
export type {
  BranchFileChange,
  CreatePullRequestInput,
  GitHubBranchPublisher,
  GitHubIntegrationOptions,
  GitHubIssue,
  GitHubIssueToPrAdapter,
  GitHubRepository,
  PublishedBranchSummary,
  PublishBranchInput,
  PullRequestSummary,
} from './github.js';
