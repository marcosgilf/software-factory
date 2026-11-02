import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type RemoteState = {
  pullRequests: Record<string, { number: number }>;
  lookupCalls: number;
  createCalls: number;
  effects: number;
};

const workerPath = fileURLToPath(new URL('./fixtures/issue-to-pr-worker.ts', import.meta.url));

describe('issue-to-PR recovery', () => {
  it.each([
    { mode: 'before-write', exitCode: 72 },
    { mode: 'after-write', exitCode: 73 },
  ] as const)(
    'creates one PR after a $mode process crash',
    async ({ mode, exitCode }) => {
      const directory = await mkdtemp(join(tmpdir(), 'factory-issue-to-pr-'));
      const databasePath = join(directory, 'session.sqlite');
      const remotePath = join(directory, 'remote.json');

      try {
        await writeFile(
          remotePath,
          JSON.stringify({ pullRequests: {}, lookupCalls: 0, createCalls: 0, effects: 0 }),
        );
        const firstRun = await runWorker([mode, databasePath, remotePath]);
        expect(firstRun.code, firstRun.stderr).toBe(exitCode);
        const taskId = firstRun.stdout.match(/^TASK:(.+)$/m)?.[1];
        expect(taskId).toBeDefined();

        const resumed = await runWorker(['resume', databasePath, remotePath, taskId!]);
        expect(resumed.code, resumed.stderr).toBe(0);
        expect(resumed.stdout).toContain('"decision":"pull_request_created"');

        const remote = JSON.parse(await readFile(remotePath, 'utf8')) as RemoteState;
        expect(remote.createCalls).toBe(1);
        expect(remote.effects).toBe(1);
        expect(Object.keys(remote.pullRequests)).toHaveLength(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function runWorker(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath, ...args], {
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
