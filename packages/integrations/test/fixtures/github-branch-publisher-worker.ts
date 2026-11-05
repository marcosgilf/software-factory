import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { GitHubIntegration, type PublishBranchInput } from '../../src/github.js';

type Commit = {
  readonly sha: string;
  readonly message: string;
  readonly tree: { readonly sha: string };
  readonly parents: readonly { readonly sha: string }[];
};

type RemoteState = {
  refs: Record<string, string>;
  commits: Record<string, Commit>;
  branchWrites: number;
  branchEffects: number;
};

const [mode, remotePath] = process.argv.slice(2);
if (mode !== 'before-ref' && mode !== 'after-ref' && mode !== 'resume') {
  throw new Error('Unknown branch publisher worker mode.');
}
if (remotePath === undefined) throw new Error('Remote state path is required.');

const baseSha = 'a'.repeat(40);
const input: PublishBranchInput = {
  operationKey: 'issue-42-run-9f4d',
  issueNumber: 42,
  base: 'main',
  baseSha,
  changes: [{ path: 'src/health.ts', content: 'export const health = () => "ok";\n' }],
};

const fetch: typeof globalThis.fetch = async (request, init) => {
  const state = JSON.parse(await readFile(remotePath, 'utf8')) as RemoteState;
  const url = new URL(String(request));
  const path = url.pathname.replace('/repos/factory-owner/factory-repo', '');
  const method = init?.method ?? 'GET';
  if (method === 'GET' && path.startsWith('/git/ref/')) {
    const ref = `refs/${decodeURIComponent(path.slice('/git/ref/'.length))}`;
    const sha = state.refs[ref];
    return sha === undefined
      ? jsonResponse({ message: 'Not Found' }, 404)
      : jsonResponse({ ref, object: { type: 'commit', sha } });
  }
  if (method === 'GET' && path.startsWith('/git/commits/')) {
    const sha = path.slice('/git/commits/'.length);
    const commit = state.commits[sha];
    return commit === undefined
      ? jsonResponse({ message: 'Not Found' }, 404)
      : jsonResponse(commit);
  }
  if (method === 'POST' && path === '/git/trees') {
    const body = JSON.parse(String(init?.body)) as { tree: unknown };
    const sha = createHash('sha1').update(JSON.stringify(body.tree)).digest('hex');
    return jsonResponse({ sha });
  }
  if (method === 'POST' && path === '/git/commits') {
    const body = JSON.parse(String(init?.body)) as {
      message: string;
      tree: string;
      parents: string[];
    };
    const sha = createHash('sha1').update(JSON.stringify(body)).digest('hex');
    state.commits[sha] = {
      sha,
      message: body.message,
      tree: { sha: body.tree },
      parents: body.parents.map((parent) => ({ sha: parent })),
    };
    await writeFile(remotePath, JSON.stringify(state));
    return jsonResponse(state.commits[sha], 201);
  }
  if (method === 'POST' && path === '/git/refs') {
    state.branchWrites += 1;
    if (mode === 'before-ref') process.exit(72);
    const body = JSON.parse(String(init?.body)) as { ref: string; sha: string };
    state.refs[body.ref] = body.sha;
    state.branchEffects += 1;
    await writeFile(remotePath, JSON.stringify(state));
    if (mode === 'after-ref') process.exit(73);
    return jsonResponse({ ref: body.ref, object: { type: 'commit', sha: body.sha } }, 201);
  }
  throw new Error(`Unexpected GitHub request: ${method} ${path}`);
};

const github = new GitHubIntegration({
  token: 'test-token',
  repository: { owner: 'factory-owner', name: 'factory-repo', defaultBranch: 'main' },
  fetch,
});
const result = await github.publishBranchOnce(input);
console.log(`BRANCH:${JSON.stringify(result)}`);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
