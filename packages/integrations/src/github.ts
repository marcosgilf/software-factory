import { createHash } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
const OPERATION_MARKER = 'software-factory:operation=';
const BRANCH_OPERATION_MARKER = 'software-factory:branch-operation=';
const GITHUB_REQUEST_ERROR = 'GitHub API request failed.';
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const MAX_BRANCH_FILES = 100;
const MAX_BRANCH_BYTES = 1_000_000;

export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
}

export interface GitHubIntegrationOptions {
  /** Backend-only token with access to this repository. Never pass it to agent tools. */
  readonly token: string;
  readonly repository: GitHubRepository;
  readonly fetch?: typeof fetch;
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: 'open' | 'closed';
  readonly url: string;
  readonly labels: readonly string[];
}

export interface CreatePullRequestInput {
  /** Stable backend-generated key, persisted before any remote write. */
  readonly operationKey: string;
  readonly head: string;
  readonly base?: string;
  readonly title: string;
  readonly body: string;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly state: 'open' | 'closed';
  readonly draft: boolean;
}

export interface GitHubIssueToPrAdapter {
  getIssue(number: number): Promise<GitHubIssue>;
  createPullRequestOnce(input: CreatePullRequestInput): Promise<PullRequestSummary>;
}

export interface BranchFileChange {
  readonly path: string;
  readonly content: string;
}

export interface PublishBranchInput {
  readonly operationKey: string;
  readonly issueNumber: number;
  readonly base: string;
  readonly baseSha: string;
  readonly changes: readonly BranchFileChange[];
}

export interface PublishedBranchSummary {
  readonly branch: string;
  readonly sha: string;
  readonly base: string;
  readonly baseSha: string;
  readonly operationKey: string;
  readonly changeDigest: string;
}

export interface GitHubBranchPublisher {
  getDefaultBranchSha(): Promise<string>;
  publishBranchOnce(input: PublishBranchInput): Promise<PublishedBranchSummary>;
}

type GitHubPullRequestRecord = PullRequestSummary & { readonly body: string | null };
type GitHubRef = { readonly ref: string; readonly sha: string };
type GitHubCommit = {
  readonly sha: string;
  readonly message: string;
  readonly treeSha: string;
  readonly parents: readonly string[];
};

/** GitHub REST adapter and branch publisher scoped to one repository and one backend-held token. */
export class GitHubIntegration implements GitHubIssueToPrAdapter, GitHubBranchPublisher {
  readonly #repository: GitHubRepository;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubIntegrationOptions) {
    if (options.token.length === 0 || /\s/.test(options.token)) {
      throw new Error('GitHub token must be a non-empty bearer token.');
    }
    validateRepository(options.repository);
    this.#repository = Object.freeze({ ...options.repository });
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error('GitHub issue number must be a positive safe integer.');
    }
    const value = asRecord(
      await this.#request(`/issues/${number}`),
      'GitHub returned an invalid issue response.',
    );
    if ('pull_request' in value) throw new Error('GitHub resource is not an issue.');
    const labels = value.labels;
    const state = value.state;
    if (
      value.number !== number ||
      typeof value.title !== 'string' ||
      (value.body !== null && typeof value.body !== 'string') ||
      (state !== 'open' && state !== 'closed') ||
      !isGitHubResourceUrl(value.html_url, this.#repository, `issues/${number}`) ||
      !Array.isArray(labels) ||
      !labels.every(
        (label) =>
          typeof asRecord(label, 'GitHub returned an invalid issue response.').name === 'string',
      )
    ) {
      throw new Error('GitHub returned an invalid issue response.');
    }

    return {
      number: value.number as number,
      title: value.title,
      body: value.body,
      state,
      url: value.html_url,
      labels: labels.map((label) => (label as { readonly name: string }).name),
    };
  }

  async getDefaultBranchSha(): Promise<string> {
    const ref = await this.#getRef(`heads/${this.#repository.defaultBranch}`);
    if (ref === undefined) throw new Error('Configured GitHub base branch was not found.');
    return ref.sha;
  }

  /** Publish only add/modify text blobs to an operation-owned branch, then reconcile retries by marker. */
  async publishBranchOnce(input: PublishBranchInput): Promise<PublishedBranchSummary> {
    const changes = validateBranchPublishInput(input, this.#repository);
    const branch = branchNameForOperation(input.operationKey);
    const refName = `heads/${branch}`;
    const changeDigest = digestChanges(changes);
    const existing = await this.#getRef(refName);
    if (existing !== undefined) {
      const baseCommit = await this.#getGitCommit(input.baseSha);
      const treeSha = await this.#createTree(baseCommit.treeSha, changes);
      const marker = branchOperationMarker(input, treeSha, changeDigest);
      return this.#reconcilePublishedBranch(existing, input, marker, changeDigest, treeSha);
    }

    await this.#assertCurrentBase(input.base, input.baseSha);
    const baseCommit = await this.#getGitCommit(input.baseSha);
    const treeSha = await this.#createTree(baseCommit.treeSha, changes);
    const marker = branchOperationMarker(input, treeSha, changeDigest);
    const commit = parseGitCommit(
      await this.#request('/git/commits', {
        method: 'POST',
        body: JSON.stringify({
          message: `Software Factory: issue #${input.issueNumber}\n\n${marker}`,
          tree: treeSha,
          parents: [input.baseSha],
        }),
      }),
    );
    if (
      commit.treeSha !== treeSha ||
      commit.parents.length !== 1 ||
      commit.parents[0] !== input.baseSha ||
      !hasSingleLineMarker(commit.message, marker)
    ) {
      throw new Error('GitHub returned a commit that does not match the branch request.');
    }

    await this.#assertCurrentBase(input.base, input.baseSha);
    const raced = await this.#getRef(refName);
    if (raced !== undefined) {
      return this.#reconcilePublishedBranch(raced, input, marker, changeDigest, treeSha);
    }

    try {
      const created = parseGitRef(
        await this.#request('/git/refs', {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/${refName}`, sha: commit.sha }),
        }),
        refName,
      );
      if (created.sha !== commit.sha) {
        throw new Error('GitHub returned a branch that does not match the request.');
      }
      return publishedBranch(branch, input, changeDigest, commit.sha);
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
      const conflicting = await this.#getRef(refName);
      if (conflicting === undefined) {
        throw new Error('GitHub branch conflict could not be reconciled.');
      }
      return this.#reconcilePublishedBranch(conflicting, input, marker, changeDigest, treeSha);
    }
  }

  /** Find a prior PR before writing, so a retry after a remote write reuses its receipt. */
  async createPullRequestOnce(input: CreatePullRequestInput): Promise<PullRequestSummary> {
    validatePullRequestInput(input, this.#repository);
    const base = input.base ?? this.#repository.defaultBranch;
    const requestDigest = createHash('sha256')
      .update(JSON.stringify([input.head, base, input.title, input.body]))
      .digest('hex');
    const marker = `${OPERATION_MARKER}${input.operationKey};request=${requestDigest}`;
    const markerComment = `<!-- ${marker} -->`;
    if (input.body.split(/\r?\n/).some((line) => line.trim() === markerComment)) {
      throw new Error('Pull request body contains the operation marker.');
    }
    const existing = await this.#findPullRequest(input.head, base, markerComment);
    if (existing !== undefined) {
      if (!existing.draft) throw new Error('Matching pull request is not a draft.');
      return existing;
    }

    await this.#assertPublishedBranch(input.operationKey, input.head);
    const body = input.body.length === 0 ? markerComment : `${input.body}\n\n${markerComment}`;
    const created = parsePullRequest(
      await this.#request('/pulls', {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base,
          body,
          draft: true,
        }),
      }),
      this.#repository,
    );
    if (
      created.head !== input.head ||
      created.base !== base ||
      !created.draft ||
      created.body === null ||
      !hasSingleLineMarker(created.body, markerComment)
    ) {
      throw new Error('GitHub returned a pull request that does not match the request.');
    }
    return withoutBody(created);
  }

  async #assertPublishedBranch(operationKey: string, branch: string): Promise<void> {
    const ref = await this.#getRef(`heads/${branch}`);
    if (ref === undefined) throw new Error('Pull request branch has not been published.');
    const commit = await this.#getGitCommit(ref.sha);
    const markers = commit.message
      .split(/\r?\n/)
      .filter((line) => line.startsWith(BRANCH_OPERATION_MARKER));
    const prefix = `${BRANCH_OPERATION_MARKER}${operationKey};`;
    const marker = markers[0];
    const match = marker?.startsWith(prefix)
      ? /^issue=[1-9][0-9]*;base=([a-f0-9]{40});tree=([a-f0-9]{40});changes=[a-f0-9]{64}$/i.exec(
          marker.slice(prefix.length),
        )
      : null;
    if (
      markers.length !== 1 ||
      match === null ||
      match[1] === undefined ||
      match[2] === undefined ||
      commit.treeSha !== match[2] ||
      commit.parents.length !== 1 ||
      commit.parents[0] !== match[1]
    ) {
      throw new Error('Pull request branch does not match its operation.');
    }
    await this.#assertCurrentBase(this.#repository.defaultBranch, match[1]);
  }

  async #findPullRequest(
    head: string,
    base: string,
    markerComment: string,
  ): Promise<PullRequestSummary | undefined> {
    const query = new URLSearchParams({
      state: 'all',
      head: `${this.#repository.owner}:${head}`,
      base,
      per_page: '100',
    });
    const response = await this.#request(`/pulls?${query}`);
    if (!Array.isArray(response)) throw new Error('GitHub returned an invalid pull request list.');
    const pullRequests = response.map((pullRequest) =>
      parsePullRequest(pullRequest, this.#repository),
    );
    const matching = pullRequests.filter(
      (pullRequest) =>
        pullRequest.body !== null && hasSingleLineMarker(pullRequest.body, markerComment),
    );
    if (matching.length > 1) {
      throw new Error('Multiple pull requests match the operation key.');
    }
    if (matching[0] !== undefined) return withoutBody(matching[0]);
    if (pullRequests.length > 0) {
      throw new Error('A pull request already exists for this branch and base.');
    }
    return undefined;
  }

  async #getRef(refName: string): Promise<GitHubRef | undefined> {
    try {
      return parseGitRef(await this.#request(`/git/ref/${encodeURIComponent(refName)}`), refName);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #assertCurrentBase(base: string, baseSha: string): Promise<void> {
    if (base !== this.#repository.defaultBranch) {
      throw new Error('GitHub branch base is not allowed.');
    }
    const ref = await this.#getRef(`heads/${base}`);
    if (ref === undefined || ref.sha !== baseSha) {
      throw new Error('GitHub base branch changed before publication.');
    }
  }

  async #getGitCommit(sha: string): Promise<GitHubCommit> {
    const commit = parseGitCommit(await this.#request(`/git/commits/${sha}`));
    if (commit.sha !== sha) throw new Error('GitHub returned a different Git commit.');
    return commit;
  }

  async #createTree(baseTreeSha: string, changes: readonly BranchFileChange[]): Promise<string> {
    const tree = asRecord(
      await this.#request('/git/trees', {
        method: 'POST',
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: changes.map(({ path, content }) => ({
            path,
            mode: '100644',
            type: 'blob',
            content,
          })),
        }),
      }),
      'GitHub returned an invalid Git tree.',
    );
    return requireSha(tree.sha, 'GitHub returned an invalid Git tree.');
  }

  async #reconcilePublishedBranch(
    ref: GitHubRef,
    input: PublishBranchInput,
    marker: string,
    changeDigest: string,
    expectedTreeSha: string,
  ): Promise<PublishedBranchSummary> {
    const commit = await this.#getGitCommit(ref.sha);
    if (
      commit.sha !== ref.sha ||
      commit.treeSha !== expectedTreeSha ||
      commit.parents.length !== 1 ||
      commit.parents[0] !== input.baseSha ||
      !hasSingleLineMarker(commit.message, marker)
    ) {
      throw new Error('GitHub branch conflicts with this operation.');
    }
    return publishedBranch(ref.ref.slice('refs/heads/'.length), input, changeDigest, ref.sha);
  }

  async #request(
    path: string,
    init: { readonly method?: 'GET' | 'POST'; readonly body?: string } = {},
  ) {
    let response: Response;
    try {
      const headers = new Headers({
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      });
      if (init.body !== undefined) headers.set('Content-Type', 'application/json');
      response = await this.#fetch(
        `${GITHUB_API}/repos/${this.#repository.owner}/${this.#repository.name}${path}`,
        {
          method: init.method ?? 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
          ...(init.body === undefined ? {} : { body: init.body }),
        },
      );
    } catch {
      throw new Error(GITHUB_REQUEST_ERROR);
    }
    if (!response.ok) throw new GitHubApiError(response.status);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error('GitHub returned invalid JSON.');
    }
  }
}

class GitHubApiError extends Error {
  constructor(readonly status: number) {
    super(`${GITHUB_REQUEST_ERROR} Status ${status}.`);
    this.name = 'GitHubApiError';
  }
}

export function branchNameForOperation(operationKey: string): string {
  validateOperationKey(operationKey);
  return `factory/issue-${createHash('sha256').update(operationKey).digest('hex')}`;
}

function validateOperationKey(operationKey: string): void {
  if (
    typeof operationKey !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationKey)
  ) {
    throw new Error('GitHub operation key is invalid.');
  }
}

function validateBranchPublishInput(
  input: PublishBranchInput,
  repository: GitHubRepository,
): readonly BranchFileChange[] {
  validateOperationKey(input.operationKey);
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('GitHub issue number must be a positive safe integer.');
  }
  if (input.base !== repository.defaultBranch) {
    throw new Error('GitHub branch base is not allowed.');
  }
  requireSha(input.baseSha, 'GitHub base commit SHA is invalid.');
  if (
    !Array.isArray(input.changes) ||
    input.changes.length === 0 ||
    input.changes.length > MAX_BRANCH_FILES
  ) {
    throw new Error('GitHub branch change set is invalid.');
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  const changes = input.changes.map((change) => {
    if (typeof change !== 'object' || change === null || Array.isArray(change)) {
      throw new Error('GitHub branch change is invalid.');
    }
    const { path, content } = change;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > 512 ||
      path.startsWith('/') ||
      path.endsWith('/') ||
      path.includes('\\') ||
      path.includes(':') ||
      [...path].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    ) {
      throw new Error('GitHub branch file path is invalid.');
    }
    const segments = path.split('/');
    const lowerSegments = segments.map((segment) => segment.toLowerCase());
    if (
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
      lowerSegments.includes('.git') ||
      lowerSegments[0] === '.github' ||
      lowerSegments.some(
        (segment) =>
          /^\.env(?:\.|$)/.test(segment) ||
          ['.npmrc', '.netrc', '.pypirc'].includes(segment) ||
          /\.(pem|key|p12|pfx)$/.test(segment),
      )
    ) {
      throw new Error('GitHub branch file path is not allowed.');
    }
    if (paths.has(path)) throw new Error('GitHub branch change set contains duplicate paths.');
    paths.add(path);
    if (typeof content !== 'string' || content.includes('\0')) {
      throw new Error('GitHub branch file content is invalid.');
    }
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_BRANCH_BYTES) {
      throw new Error('GitHub branch change set exceeds its size limit.');
    }
    return { path, content };
  });

  return changes.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function hasSingleLineMarker(value: string, marker: string): boolean {
  return value.split(/\r?\n/).filter((line) => line.trim() === marker).length === 1;
}

function branchOperationMarker(
  input: PublishBranchInput,
  treeSha: string,
  changeDigest: string,
): string {
  return `${BRANCH_OPERATION_MARKER}${input.operationKey};issue=${input.issueNumber};base=${input.baseSha};tree=${treeSha};changes=${changeDigest}`;
}

function digestChanges(changes: readonly BranchFileChange[]): string {
  return createHash('sha256')
    .update(JSON.stringify(changes.map(({ path, content }) => [path, content])))
    .digest('hex');
}

function publishedBranch(
  branch: string,
  input: PublishBranchInput,
  changeDigest: string,
  sha: string,
): PublishedBranchSummary {
  return {
    branch,
    sha,
    base: input.base,
    baseSha: input.baseSha,
    operationKey: input.operationKey,
    changeDigest,
  };
}

function parseGitRef(value: unknown, refName: string): GitHubRef {
  const record = asRecord(value, 'GitHub returned an invalid Git reference.');
  const object = asRecord(record.object, 'GitHub returned an invalid Git reference.');
  const sha = requireSha(object.sha, 'GitHub returned an invalid Git reference.');
  if (record.ref !== `refs/${refName}` || object.type !== 'commit') {
    throw new Error('GitHub returned an invalid Git reference.');
  }
  return { ref: record.ref, sha };
}

function parseGitCommit(value: unknown): GitHubCommit {
  const record = asRecord(value, 'GitHub returned an invalid Git commit.');
  const tree = asRecord(record.tree, 'GitHub returned an invalid Git commit.');
  if (
    typeof record.message !== 'string' ||
    !Array.isArray(record.parents) ||
    !record.parents.every((parent) => {
      if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return false;
      return isSha((parent as { readonly sha?: unknown }).sha);
    })
  ) {
    throw new Error('GitHub returned an invalid Git commit.');
  }
  return {
    sha: requireSha(record.sha, 'GitHub returned an invalid Git commit.'),
    message: record.message,
    treeSha: requireSha(tree.sha, 'GitHub returned an invalid Git commit.'),
    parents: record.parents.map((parent) => (parent as { readonly sha: string }).sha),
  };
}

function requireSha(value: unknown, error: string): string {
  if (!isSha(value)) throw new Error(error);
  return value;
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function isGitHubResourceUrl(
  value: unknown,
  repository: GitHubRepository,
  resource: string,
): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const expectedPath = `/${repository.owner}/${repository.name}/${resource}`.toLowerCase();
    return (
      url.origin === 'https://github.com' &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname.toLowerCase() === expectedPath &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function validateRepository(repository: GitHubRepository): void {
  if (
    !/^[A-Za-z0-9-]+$/.test(repository.owner) ||
    !/^[A-Za-z0-9._-]+$/.test(repository.name) ||
    !isBranchName(repository.defaultBranch)
  ) {
    throw new Error('GitHub repository configuration is invalid.');
  }
}

function validatePullRequestInput(
  input: CreatePullRequestInput,
  repository: GitHubRepository,
): void {
  validateOperationKey(input.operationKey);
  if (input.head !== branchNameForOperation(input.operationKey)) {
    throw new Error('Pull request head does not match its operation key.');
  }
  if (input.base !== undefined && input.base !== repository.defaultBranch) {
    throw new Error('Pull request base branch is not allowed.');
  }
  if (
    typeof input.title !== 'string' ||
    input.title.trim().length === 0 ||
    input.title.length > 256
  ) {
    throw new Error('Pull request title is invalid.');
  }
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > 60_000) {
    throw new Error('Pull request body is invalid.');
  }
}

function isBranchName(value: string): boolean {
  const forbidden = ['~', '^', ':', '?', '*', '[', ']', '\\'];
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '@' &&
    value === value.trim() &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.startsWith('.') &&
    !value.endsWith('.') &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('@{') &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127 || forbidden.includes(character);
    }) &&
    value.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.')) &&
    value.split('/').every((segment) => !segment.toLowerCase().endsWith('.lock'))
  );
}

function parsePullRequest(value: unknown, repository: GitHubRepository): GitHubPullRequestRecord {
  const record = asRecord(value, 'GitHub returned an invalid pull request response.');
  const head = asRecord(record.head, 'GitHub returned an invalid pull request response.');
  const base = asRecord(record.base, 'GitHub returned an invalid pull request response.');
  if (
    !Number.isSafeInteger(record.number) ||
    !isGitHubResourceUrl(record.html_url, repository, `pull/${record.number}`) ||
    (record.state !== 'open' && record.state !== 'closed') ||
    typeof record.draft !== 'boolean' ||
    typeof head.ref !== 'string' ||
    typeof base.ref !== 'string' ||
    (record.body !== null && typeof record.body !== 'string')
  ) {
    throw new Error('GitHub returned an invalid pull request response.');
  }
  return {
    number: record.number as number,
    url: record.html_url,
    head: head.ref,
    base: base.ref,
    state: record.state,
    draft: record.draft,
    body: record.body,
  };
}

function asRecord(value: unknown, error: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function withoutBody(record: GitHubPullRequestRecord): PullRequestSummary {
  const { body: _body, ...summary } = record;
  return summary;
}
