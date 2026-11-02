import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitHubIssue } from '@factory/integrations';
import type { IssueWorkspaceExecutor, PreparedIssueChange } from '@factory/workflows';

const DOCKER_IMAGE = 'node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d';
const DOCKER_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 16_384;
const WORKER_SOURCE = `import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const input = JSON.parse(await readFile('/workspace/issue.json', 'utf8'));
if (
  !Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0 ||
  typeof input.operationKey !== 'string' || !/^[0-9a-f-]{36}$/.test(input.operationKey)
) process.exit(1);

await writeFile('/workspace/health.mjs', 'export function health() { return { status: "ok" }; }\\n');
await writeFile(
  '/workspace/health.test.mjs',
  "import { test } from 'node:test';\\n" +
    "import assert from 'node:assert/strict';\\n" +
    "import { health } from './health.mjs';\\n" +
    "test('health check returns ok', () => assert.deepEqual(health(), { status: 'ok' }));\\n",
);
const test = spawnSync(process.execPath, ['--test', '/workspace/health.test.mjs'], {
  cwd: '/workspace',
  stdio: 'ignore',
  timeout: 10000,
});
if (test.error !== undefined || test.status !== 0) process.exit(1);

await writeFile('/workspace/result.json', JSON.stringify({
  head: 'factory/issue-' + input.issueNumber + '-' + input.operationKey.slice(0, 8),
  base: 'main',
  title: '[Mock] Add a health check',
  body: 'Prepared in a network-isolated Docker workspace. One test passed.',
}));
`;

const DOCKER_ENV_KEYS = [
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_API_VERSION',
] as const;

export class DockerMockIssueWorkspaceExecutor implements IssueWorkspaceExecutor {
  async prepare(
    issue: GitHubIssue,
    operationKey: string,
    signal: AbortSignal,
  ): Promise<PreparedIssueChange> {
    if (signal.aborted) throw new Error('Docker workspace execution was cancelled.');
    const dockerHost = process.env.DOCKER_HOST;
    const endpoint =
      dockerHost ??
      (
        await runDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], signal)
      ).trim();
    assertLocalDockerEndpoint(endpoint);

    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined || uid === 0) {
      throw new Error('Docker workspace requires a non-root Unix host user.');
    }
    assertDockerOperationKey(operationKey);

    const workspace = join(homedir(), `.factory-issue-workspace-${operationKey}`);
    const containerName = `factory-issue-${operationKey}`;
    await removeContainer(containerName, endpoint);
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { mode: 0o700 });
    try {
      await writeFile(
        join(workspace, 'issue.json'),
        JSON.stringify({ issueNumber: issue.number, operationKey }),
        { mode: 0o600 },
      );
      await writeFile(join(workspace, 'worker.mjs'), WORKER_SOURCE, { mode: 0o600 });
      const output = await runDocker(
        buildDockerRunArgs(workspace, containerName, uid, gid, endpoint),
        signal,
      );
      const result = JSON.parse(await readFile(join(workspace, 'result.json'), 'utf8')) as unknown;
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new Error('Docker workspace returned an invalid result.');
      }
      const prepared = result as Record<string, unknown>;
      if (
        typeof prepared.head !== 'string' ||
        typeof prepared.base !== 'string' ||
        typeof prepared.title !== 'string' ||
        typeof prepared.body !== 'string' ||
        output.trim().length !== 0
      ) {
        throw new Error('Docker workspace returned an invalid result.');
      }
      return {
        head: prepared.head,
        base: prepared.base,
        title: prepared.title,
        body: prepared.body,
      };
    } finally {
      await removeContainer(containerName, endpoint);
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export function buildDockerRunArgs(
  workspace: string,
  containerName: string,
  uid: number,
  gid: number,
  endpoint: string,
): string[] {
  assertLocalDockerEndpoint(endpoint);
  return [
    '--host',
    endpoint,
    'run',
    '--rm',
    '--pull=never',
    '--name',
    containerName,
    '--network=none',
    '--user',
    `${uid}:${gid}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=64',
    '--memory=256m',
    '--cpus=1',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount',
    `type=bind,src=${workspace},dst=/workspace`,
    '--workdir',
    '/workspace',
    DOCKER_IMAGE,
    'node',
    '/workspace/worker.mjs',
  ];
}

export function assertDockerOperationKey(operationKey: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationKey)
  ) {
    throw new Error('Docker workspace operation key is invalid.');
  }
}

export function assertLocalDockerEndpoint(endpoint: string): void {
  if (!endpoint.startsWith('unix://')) {
    throw new Error('Docker workspace requires a local Unix socket.');
  }
}

export function buildDockerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: source.PATH ?? '/usr/bin:/bin' };
  for (const key of DOCKER_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function runDocker(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: buildDockerEnvironment(process.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const timeout = setTimeout(
      () => terminate(new Error('Docker workspace execution timed out.')),
      DOCKER_TIMEOUT_MS,
    );
    let killTimeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      signal.removeEventListener('abort', onAbort);
    };
    const settle = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(value ?? '');
    };
    const terminate = (error: Error) => {
      if (failure !== undefined) return;
      failure = error;
      child.kill('SIGTERM');
      killTimeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const onAbort = () => terminate(new Error('Docker workspace execution was cancelled.'));

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate(new Error('Docker workspace output exceeded its limit.'));
      } else {
        stdout += chunk.toString('utf8');
      }
    });
    child.once('error', () => settle(new Error('Docker workspace process could not start.')));
    child.once('close', (code) => {
      if (failure !== undefined) settle(failure);
      else if (code !== 0) settle(new Error('Docker workspace execution failed.'));
      else settle(undefined, stdout);
    });
  });
}

function removeContainer(containerName: string, endpoint: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['--host', endpoint, 'rm', '--force', containerName], {
      env: buildDockerEnvironment(process.env),
      shell: false,
      stdio: 'ignore',
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    const done = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once('error', done);
    child.once('close', done);
  });
}
