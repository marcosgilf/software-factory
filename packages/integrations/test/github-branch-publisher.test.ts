import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  branchNameForOperation,
  GitHubIntegration,
  type PublishBranchInput,
} from '../src/github.js';

const token = 'backend-only-test-token';
const repository = { owner: 'factory-owner', name: 'factory-repo', defaultBranch: 'main' };
const baseSha = 'a'.repeat(40);
const baseTreeSha = 'b'.repeat(40);
const operationKey = 'issue-42-run-9f4d';
const input: PublishBranchInput = {
  operationKey,
  issueNumber: 42,
  base: 'main',
  baseSha,
  changes: [{ path: 'src/health.ts', content: 'export const health = () => "ok";\n' }],
};

type Commit = {
  readonly sha: string;
  readonly message: string;
  readonly tree: { readonly sha: string };
  readonly parents: readonly { readonly sha: string }[];
};

type Remote = {
  readonly refs: Map<string, string>;
  readonly commits: Map<string, Commit>;
  refEffects: number;
  commitWrites: number;
  baseReads: number;
  moveBaseOnSecondRead: boolean;
};

describe('GitHub restricted branch publisher', () => {
  it('reads only configured default branch SHA', async () => {
    const remote = createRemote();
    const integration = new GitHubIntegration({ token, repository, fetch: createFetch(remote) });

    await expect(integration.getDefaultBranchSha()).resolves.toBe(baseSha);
  });

  it('rejects a changed base before publishing a branch', async () => {
    const remote = createRemote();
    remote.moveBaseOnSecondRead = true;
    const integration = new GitHubIntegration({ token, repository, fetch: createFetch(remote) });

    await expect(integration.publishBranchOnce(input)).rejects.toThrow(
      'GitHub base branch changed before publication.',
    );
    expect(remote.refEffects).toBe(0);
  });

  it('rejects reuse of an operation key for different file content', async () => {
    const remote = createRemote();
    const integration = new GitHubIntegration({ token, repository, fetch: createFetch(remote) });
    await integration.publishBranchOnce(input);

    await expect(
      integration.publishBranchOnce({
        ...input,
        changes: [{ path: 'src/health.ts', content: 'different change' }],
      }),
    ).rejects.toThrow('GitHub branch conflicts with this operation.');
    expect(remote.refEffects).toBe(1);
  });

  it('fails closed when operation branch exists with a different commit marker', async () => {
    const remote = createRemote();
    const branch = branchNameForOperation(operationKey);
    const conflictingSha = 'c'.repeat(40);
    remote.refs.set(`refs/heads/${branch}`, conflictingSha);
    remote.commits.set(conflictingSha, {
      sha: conflictingSha,
      message: 'unrelated commit',
      tree: { sha: baseTreeSha },
      parents: [{ sha: baseSha }],
    });
    const integration = new GitHubIntegration({ token, repository, fetch: createFetch(remote) });

    await expect(integration.publishBranchOnce(input)).rejects.toThrow(
      'GitHub branch conflicts with this operation.',
    );
    expect(remote.refEffects).toBe(0);
  });

  it('rejects duplicate, binary, and oversized changes before making a GitHub request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const integration = new GitHubIntegration({ token, repository, fetch });
    const invalidChanges = [
      [
        { path: 'src/a.ts', content: 'one' },
        { path: 'src/a.ts', content: 'two' },
      ],
      [{ path: 'src/binary.ts', content: `not${String.fromCharCode(0)}text` }],
      [{ path: 'src/large.ts', content: 'x'.repeat(1_000_001) }],
      Array.from({ length: 101 }, (_, index) => ({ path: `src/${index}.ts`, content: '' })),
    ];

    for (const changes of invalidChanges) {
      await expect(integration.publishBranchOnce({ ...input, changes })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['../outside.ts', '.env', '.github/workflows/ci.yml', 'secrets/private.pem'])(
    'rejects restricted path %s before making a GitHub request',
    async (path) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const integration = new GitHubIntegration({ token, repository, fetch });

      await expect(
        integration.publishBranchOnce({ ...input, changes: [{ path, content: 'data' }] }),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

function createRemote(): Remote {
  const baseCommit: Commit = {
    sha: baseSha,
    message: 'Base commit',
    tree: { sha: baseTreeSha },
    parents: [],
  };
  return {
    refs: new Map([['refs/heads/main', baseSha]]),
    commits: new Map([[baseSha, baseCommit]]),
    refEffects: 0,
    commitWrites: 0,
    baseReads: 0,
    moveBaseOnSecondRead: false,
  };
}

function createFetch(remote: Remote): typeof globalThis.fetch {
  return async (request, init) => {
    const url = new URL(String(request));
    const path = url.pathname.replace('/repos/factory-owner/factory-repo', '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path.startsWith('/git/ref/')) {
      const refName = `refs/${decodeURIComponent(path.slice('/git/ref/'.length))}`;
      if (refName === 'refs/heads/main') {
        remote.baseReads += 1;
        if (remote.moveBaseOnSecondRead && remote.baseReads > 1) {
          return jsonResponse({ ref: refName, object: { type: 'commit', sha: 'd'.repeat(40) } });
        }
      }
      const sha = remote.refs.get(refName);
      return sha === undefined
        ? jsonResponse({ message: 'Not Found' }, 404)
        : jsonResponse({ ref: refName, object: { type: 'commit', sha } });
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const sha = path.slice('/git/commits/'.length);
      const commit = remote.commits.get(sha);
      return commit === undefined
        ? jsonResponse({ message: 'Not Found' }, 404)
        : jsonResponse(commit);
    }
    if (method === 'POST' && path === '/git/trees') {
      const body = JSON.parse(String(init?.body)) as { tree: unknown };
      const treeSha = createHash('sha1').update(JSON.stringify(body.tree)).digest('hex');
      return jsonResponse({ sha: treeSha });
    }
    if (method === 'POST' && path === '/git/commits') {
      const body = JSON.parse(String(init?.body)) as {
        message: string;
        tree: string;
        parents: string[];
      };
      remote.commitWrites += 1;
      const sha = createHash('sha1')
        .update(JSON.stringify({ body, commitWrites: remote.commitWrites }))
        .digest('hex');
      const commit: Commit = {
        sha,
        message: body.message,
        tree: { sha: body.tree },
        parents: body.parents.map((parent) => ({ sha: parent })),
      };
      remote.commits.set(sha, commit);
      return jsonResponse(commit, 201);
    }
    if (method === 'POST' && path === '/git/refs') {
      const body = JSON.parse(String(init?.body)) as { ref: string; sha: string };
      if (remote.refs.has(body.ref)) return jsonResponse({ message: 'Reference exists' }, 422);
      remote.refs.set(body.ref, body.sha);
      remote.refEffects += 1;
      return jsonResponse({ ref: body.ref, object: { type: 'commit', sha: body.sha } }, 201);
    }
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
