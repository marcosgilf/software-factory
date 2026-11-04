import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteSessionCatalog } from '@factory/agent-runtime';
import { createIssueToPrRuntime, parseGitHubRuntimeConfig } from '../src/issue-to-pr-runtime.js';

const githubEnvironment: NodeJS.ProcessEnv = {
  FACTORY_ISSUE_TO_PR_MODE: 'github',
  FACTORY_GITHUB_TOKEN: 'backend-only-test-token',
  FACTORY_GITHUB_REPOSITORY: 'factory-owner/factory-repo',
  FACTORY_GITHUB_DEFAULT_BRANCH: 'main',
  FACTORY_GITHUB_ALLOWED_REPOSITORIES: 'factory-owner/factory-repo',
};

describe('issue-to-PR runtime configuration', () => {
  it('keeps workflow disabled unless an explicit mode is configured', () => {
    expect(createIssueToPrRuntime({})).toBeUndefined();
    expect(() => createIssueToPrRuntime({ FACTORY_ISSUE_TO_PR_MODE: 'other' })).toThrow(
      'FACTORY_ISSUE_TO_PR_MODE must be mock or github.',
    );
  });

  it('preserves mock mode without reading GitHub credentials', () => {
    const runtime = createIssueToPrRuntime({
      FACTORY_ISSUE_TO_PR_MODE: 'mock',
      FACTORY_GITHUB_TOKEN: 'ignored-test-token',
    });

    expect(runtime).toBeDefined();
    expect(runtime?.branchPublisher).toBeUndefined();
  });

  it('requires an allowlisted repository and complete backend configuration', () => {
    expect(() =>
      parseGitHubRuntimeConfig({ ...githubEnvironment, FACTORY_GITHUB_TOKEN: undefined }),
    ).toThrow('GitHub mode requires token, repository, default branch, and repository allowlist.');
    expect(() =>
      parseGitHubRuntimeConfig({
        ...githubEnvironment,
        FACTORY_GITHUB_ALLOWED_REPOSITORIES: 'other/repository',
      }),
    ).toThrow('Configured GitHub repository is not in the repository allowlist.');
  });

  it('normalizes allowlist matching but rejects duplicate repository entries', () => {
    expect(
      parseGitHubRuntimeConfig({
        ...githubEnvironment,
        FACTORY_GITHUB_ALLOWED_REPOSITORIES: 'Factory-Owner/Factory-Repo,other/repo',
      }).repository,
    ).toEqual({ owner: 'factory-owner', name: 'factory-repo', defaultBranch: 'main' });
    expect(() =>
      parseGitHubRuntimeConfig({
        ...githubEnvironment,
        FACTORY_GITHUB_ALLOWED_REPOSITORIES:
          'factory-owner/factory-repo,FACTORY-OWNER/FACTORY-REPO',
      }),
    ).toThrow('GitHub repository allowlist contains duplicates.');
  });

  it('uses the real adapter for issue lookup and fails before branch or PR writes without an executor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-github-runtime-'));
    const requests: { method: string; url: string; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        method: init?.method ?? 'GET',
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return jsonResponse({
        number: 42,
        title: 'Add a health check',
        body: 'Issue body stays in backend.',
        state: 'open',
        html_url: 'https://github.com/factory-owner/factory-repo/issues/42',
        labels: [{ name: 'factory/approved' }],
      });
    };
    const runtime = createIssueToPrRuntime(githubEnvironment, fetchImpl);
    if (runtime === undefined) throw new Error('GitHub runtime was not configured.');
    const catalog = new SqliteSessionCatalog({
      directory,
      harnessOptions: runtime.harnessOptions,
    });

    try {
      await catalog.start();
      const session = await catalog.createSession();
      const task = await runtime.issueToPrService.start(session, 42);
      const progress = await waitForStatus(async () =>
        runtime.issueToPrService.progress(session, String(task.id)),
      );

      expect(progress.status).toBe('failed');
      expect(runtime.branchPublisher).toBe(runtime.github);
      expect(JSON.stringify(runtime.github)).not.toContain('backend-only-test-token');
      expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
        ['GET', '/repos/factory-owner/factory-repo/issues/42'],
      ]);
      expect(requests[0]?.authorization).toBe('Bearer backend-only-test-token');
    } finally {
      await catalog.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

async function waitForStatus<T extends { readonly status: string }>(
  read: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (value.status === 'failed') return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The GitHub workflow did not fail closed before preparation.');
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}
