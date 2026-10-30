import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MOCK_OPERATION_KEY,
  MOCK_RECEIPT_PREFIX,
  RECOVERY_WORKER_MODE,
} from './fixtures/recovery-protocol.js';

const workerPath = fileURLToPath(new URL('./fixtures/recovery-worker.ts', import.meta.url));

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

describe('Pi Durable recovery', () => {
  it('reopens SQLite after process loss and reconciles an already-created idempotent effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-recovery-'));
    const databasePath = join(directory, 'session.sqlite');
    const remotePath = join(directory, 'remote.json');

    try {
      await writeFile(
        remotePath,
        JSON.stringify({ records: {}, lookupCalls: 0, createCalls: 0, effects: 0 }),
      );
      const firstRun = await runWorker([RECOVERY_WORKER_MODE.crash, databasePath, remotePath]);
      expect(firstRun.code, firstRun.stderr).toBe(73);
      const taskId = firstRun.stdout.match(/^TASK:(.+)$/m)?.[1];
      expect(taskId).toBeDefined();

      const resumed = await runWorker([
        RECOVERY_WORKER_MODE.resume,
        databasePath,
        remotePath,
        taskId!,
      ]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain('"reconciled":true');

      const remote = JSON.parse(await readFile(remotePath, 'utf8')) as {
        records: Record<string, string>;
        lookupCalls: number;
        createCalls: number;
        effects: number;
      };
      expect(remote.lookupCalls).toBe(2);
      expect(remote.createCalls).toBe(1);
      expect(remote.effects).toBe(1);
      expect(remote.records[MOCK_OPERATION_KEY]).toBe(
        `${MOCK_RECEIPT_PREFIX}${MOCK_OPERATION_KEY}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
