import { describe, expect, it, vi } from 'vitest';
import { branchNameForOperation, GitHubIntegration } from '../src/github.js';

const token = 'backend-only-test-token';
const repository = { owner: 'factory-owner', name: 'factory-repo', defaultBranch: 'main' };

describe('GitHub integration', () => {
  it('reads typed issue data without returning credentials', async () => {
    const requests: {
      url: string;
      authorization: string | null;
      redirect: RequestRedirect | undefined;
    }[] = [];
    const integration = new GitHubIntegration({
      token,
      repository,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('Authorization'),
          redirect: init?.redirect,
        });
        return jsonResponse({
          number: 42,
          title: 'Add a health check',
          body: 'Please add a health check.',
          state: 'open',
          html_url: 'https://github.com/factory-owner/factory-repo/issues/42',
          labels: [{ name: 'factory/approved' }],
        });
      },
    });

    const issue = await integration.getIssue(42);

    expect(issue).toEqual({
      number: 42,
      title: 'Add a health check',
      body: 'Please add a health check.',
      state: 'open',
      url: 'https://github.com/factory-owner/factory-repo/issues/42',
      labels: ['factory/approved'],
    });
    expect(requests).toEqual([
      {
        url: 'https://api.github.com/repos/factory-owner/factory-repo/issues/42',
        authorization: `Bearer ${token}`,
        redirect: 'error',
      },
    ]);
    expect(JSON.stringify(issue)).not.toContain(token);
  });

  it('reconciles a lost create response by operation key without creating a second PR', async () => {
    const pullRequests: Record<string, unknown>[] = [];
    const operationKey = 'issue-42-run-9f4d';
    const head = branchNameForOperation(operationKey);
    const baseSha = 'a'.repeat(40);
    const branchSha = 'c'.repeat(40);
    const branchTreeSha = 'b'.repeat(40);
    const branchMarker = `software-factory:branch-operation=${operationKey};issue=42;base=${baseSha};tree=${branchTreeSha};changes=${'d'.repeat(64)}`;
    let createCalls = 0;
    let loseFirstCreateResponse = true;
    const integration = new GitHubIntegration({
      token,
      repository,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const refPath = url.pathname.split('/git/ref/')[1];
        if (init?.method !== 'POST' && refPath !== undefined) {
          const refName = `refs/${decodeURIComponent(refPath)}`;
          const sha =
            refName === 'refs/heads/main'
              ? baseSha
              : refName === `refs/heads/${head}`
                ? branchSha
                : undefined;
          return sha === undefined
            ? jsonResponse({ message: 'Not Found' }, 404)
            : jsonResponse({ ref: refName, object: { type: 'commit', sha } });
        }
        if (init?.method !== 'POST' && url.pathname.endsWith(`/git/commits/${branchSha}`)) {
          return jsonResponse({
            sha: branchSha,
            message: `Software Factory: issue #42\n\n${branchMarker}`,
            tree: { sha: branchTreeSha },
            parents: [{ sha: baseSha }],
          });
        }
        if (url.pathname.endsWith('/pulls') && init?.method === 'GET') {
          const head = url.searchParams.get('head');
          const base = url.searchParams.get('base');
          return jsonResponse(
            pullRequests.filter((pull) => {
              const pullHead = pull.head as { ref?: string; label?: string } | undefined;
              const pullBase = pull.base as { ref?: string } | undefined;
              return (
                (pullHead?.label === head || `factory-owner:${pullHead?.ref}` === head) &&
                pullBase?.ref === base
              );
            }),
          );
        }
        if (url.pathname.endsWith('/pulls') && init?.method === 'POST') {
          createCalls += 1;
          const payload = JSON.parse(String(init.body)) as {
            base: string;
            body: string;
            draft: boolean;
            head: string;
            title: string;
          };
          const pull = {
            number: 7,
            html_url: 'https://github.com/factory-owner/factory-repo/pull/7',
            state: 'open',
            draft: payload.draft,
            head: { ref: payload.head, label: `factory-owner:${payload.head}` },
            base: { ref: payload.base },
            body: payload.body,
          };
          pullRequests.push(pull);
          if (loseFirstCreateResponse) {
            loseFirstCreateResponse = false;
            throw new TypeError('Connection dropped after remote write.');
          }
          return jsonResponse(pull, 201);
        }
        throw new Error(`Unexpected GitHub request: ${url.pathname}`);
      },
    });
    const input = {
      operationKey,
      head,
      title: 'Add a health check',
      body: 'Implements the approved change.',
    };

    await expect(integration.createPullRequestOnce(input)).rejects.toThrow(
      'GitHub API request failed.',
    );
    const recovered = await integration.createPullRequestOnce(input);

    expect(createCalls).toBe(1);
    expect(pullRequests).toHaveLength(1);
    expect(recovered).toEqual({
      number: 7,
      url: 'https://github.com/factory-owner/factory-repo/pull/7',
      head: input.head,
      base: 'main',
      state: 'open',
      draft: true,
    });
    expect(String(pullRequests[0]?.body)).toMatch(
      /<!-- software-factory:operation=issue-42-run-9f4d;request=[a-f0-9]{64} -->/,
    );
    await expect(
      integration.createPullRequestOnce({ ...input, body: 'A different change.' }),
    ).rejects.toThrow('A pull request already exists for this branch and base.');
    expect(createCalls).toBe(1);
  });

  it('does not create a PR until matching operation branch exists', async () => {
    const requests: { method: string; path: string }[] = [];
    const integration = new GitHubIntegration({
      token,
      repository,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ method: init?.method ?? 'GET', path: url.pathname });
        if (url.pathname.endsWith('/pulls') && init?.method === 'GET') return jsonResponse([]);
        if (url.pathname.includes('/git/ref/')) return jsonResponse({ message: 'Not Found' }, 404);
        throw new Error('Unexpected GitHub request.');
      },
    });
    const operationKey = 'issue-42-run-9f4d';

    await expect(
      integration.createPullRequestOnce({
        operationKey,
        head: branchNameForOperation(operationKey),
        title: 'Add a health check',
        body: 'Prepared change.',
      }),
    ).rejects.toThrow('Pull request branch has not been published.');
    expect(requests.some(({ method, path }) => method === 'POST' && path.endsWith('/pulls'))).toBe(
      false,
    );
  });

  it('rejects issue metadata from another repository and arbitrary PR branches', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        number: 42,
        title: 'Issue 42',
        body: null,
        state: 'open',
        html_url: 'https://github.com/other/repository/issues/42',
        labels: [],
      }),
    );
    const integration = new GitHubIntegration({ token, repository, fetch });

    await expect(integration.getIssue(42)).rejects.toThrow(
      'GitHub returned an invalid issue response.',
    );
    await expect(
      integration.createPullRequestOnce({
        operationKey: 'issue-42-run-9f4d',
        head: 'main',
        title: 'Unsafe head',
        body: '',
      }),
    ).rejects.toThrow('Pull request head does not match its operation key.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not expose response bodies in API errors', async () => {
    const integration = new GitHubIntegration({
      token,
      repository,
      fetch: async () => jsonResponse({ message: `Invalid token ${token}` }, 401),
    });
    let message = '';

    try {
      await integration.getIssue(42);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe('GitHub API request failed. Status 401.');
    expect(message).not.toContain(token);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
