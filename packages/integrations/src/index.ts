declare const integrationIdBrand: unique symbol;

export type IntegrationId = string & { readonly [integrationIdBrand]: true };

export type IntegrationProvider = 'github';

export { GitHubIntegration } from './github.js';
export type {
  CreatePullRequestInput,
  GitHubIntegrationOptions,
  GitHubIssue,
  GitHubIssueToPrAdapter,
  GitHubRepository,
  PullRequestSummary,
} from './github.js';
