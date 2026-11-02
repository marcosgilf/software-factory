const GITHUB_API = 'https://api.github.com';
const OPERATION_MARKER = 'software-factory:operation=';
const GITHUB_REQUEST_ERROR = 'GitHub API request failed.';

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

type GitHubPullRequestRecord = PullRequestSummary & { readonly body: string | null };

/** GitHub REST adapter scoped to one repository and one backend-held token. */
export class GitHubIntegration implements GitHubIssueToPrAdapter {
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
      !Number.isSafeInteger(value.number) ||
      typeof value.title !== 'string' ||
      (value.body !== null && typeof value.body !== 'string') ||
      (state !== 'open' && state !== 'closed') ||
      typeof value.html_url !== 'string' ||
      !value.html_url.startsWith('https://github.com/') ||
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

  /** Find a prior PR before writing, so a retry after a remote write reuses its receipt. */
  async createPullRequestOnce(input: CreatePullRequestInput): Promise<PullRequestSummary> {
    validatePullRequestInput(input);
    const base = input.base ?? this.#repository.defaultBranch;
    const marker = `${OPERATION_MARKER}${input.operationKey}`;
    const existing = await this.#findPullRequest(input.head, base, marker);
    if (existing !== undefined) return existing;

    const body =
      input.body.length === 0 ? `<!-- ${marker} -->` : `${input.body}\n\n<!-- ${marker} -->`;
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
    );
    if (
      created.head !== input.head ||
      created.base !== base ||
      created.body?.includes(marker) !== true
    ) {
      throw new Error('GitHub returned a pull request that does not match the request.');
    }
    return withoutBody(created);
  }

  async #findPullRequest(
    head: string,
    base: string,
    marker: string,
  ): Promise<PullRequestSummary | undefined> {
    const query = new URLSearchParams({
      state: 'all',
      head: `${this.#repository.owner}:${head}`,
      base,
      per_page: '100',
    });
    const response = await this.#request(`/pulls?${query}`);
    if (!Array.isArray(response)) throw new Error('GitHub returned an invalid pull request list.');
    const pullRequests = response.map(parsePullRequest);
    const matching = pullRequests.filter((pullRequest) => pullRequest.body?.includes(marker));
    if (matching.length > 1) {
      throw new Error('Multiple pull requests match the operation key.');
    }
    if (matching[0] !== undefined) return withoutBody(matching[0]);
    if (pullRequests.length > 0) {
      throw new Error('A pull request already exists for this branch and base.');
    }
    return undefined;
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
          ...(init.body === undefined ? {} : { body: init.body }),
        },
      );
    } catch {
      throw new Error(GITHUB_REQUEST_ERROR);
    }
    if (!response.ok) throw new Error(`${GITHUB_REQUEST_ERROR} Status ${response.status}.`);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error('GitHub returned invalid JSON.');
    }
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

function validatePullRequestInput(input: CreatePullRequestInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationKey)) {
    throw new Error('Pull request operation key is invalid.');
  }
  if (!isBranchName(input.head) || (input.base !== undefined && !isBranchName(input.base))) {
    throw new Error('Pull request branch is invalid.');
  }
  if (input.title.trim().length === 0 || input.title.length > 256) {
    throw new Error('Pull request title is invalid.');
  }
}

function isBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !/[\s~^:?*]/.test(value) &&
    !value.includes('[') &&
    !value.includes(']') &&
    !value.includes('\\')
  );
}

function parsePullRequest(value: unknown): GitHubPullRequestRecord {
  const record = asRecord(value, 'GitHub returned an invalid pull request response.');
  const head = asRecord(record.head, 'GitHub returned an invalid pull request response.');
  const base = asRecord(record.base, 'GitHub returned an invalid pull request response.');
  if (
    !Number.isSafeInteger(record.number) ||
    typeof record.html_url !== 'string' ||
    !record.html_url.startsWith('https://github.com/') ||
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
