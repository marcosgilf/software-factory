import { describe, expect, it } from 'vitest';
import { GitHubIntegration } from '../src/github.js';

const token = 'backend-only-test-token';
const repository = { owner: 'factory-owner', name: 'factory-repo', defaultBranch: 'main' };

describe('GitHub integration', () => {
  it('reads typed issue data without returning credentials', async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const integration = new GitHubIntegration({
      token,
      repository,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('Authorization'),
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
      },
    ]);
    expect(JSON.stringify(issue)).not.toContain(token);
  });

  it('reconciles a lost create response by operation key without creating a second PR', async () => {
    const pullRequests: Record<string, unknown>[] = [];
    let createCalls = 0;
    let loseFirstCreateResponse = true;
    const integration = new GitHubIntegration({
      token,
      repository,
      fetch: async (input, init) => {
        const url = new URL(String(input));
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
      operationKey: 'issue-42-run-9f4d',
      head: 'factory/issue-42-run-9f4d',
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
    expect(String(pullRequests[0]?.body)).toContain(
      '<!-- software-factory:operation=issue-42-run-9f4d -->',
    );
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
