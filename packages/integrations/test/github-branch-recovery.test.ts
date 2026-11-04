import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workerPath = fileURLToPath(
  new URL('./fixtures/github-branch-publisher-worker.ts', import.meta.url),
);
const baseSha = 'a'.repeat(40);
const baseTreeSha = 'b'.repeat(40);

type RemoteState = {
  refs: Record<string, string>;
  commits: Record<
    string,
    { readonly sha: string; readonly parents: readonly { readonly sha: string }[] }
  >;
  branchWrites: number;
  branchEffects: number;
};

describe('GitHub branch publication recovery', () => {
  it.each([
    { mode: 'before-ref', exitCode: 72 },
    { mode: 'after-ref', exitCode: 73 },
  ] as const)(
    'recovers one branch after a process crash $mode ref write',
    async ({ mode, exitCode }) => {
      const directory = await mkdtemp(join(tmpdir(), 'factory-github-branch-'));
      const remotePath = join(directory, 'remote.json');
      const baseCommit = {
        sha: baseSha,
        message: 'Base commit',
        tree: { sha: baseTreeSha },
        parents: [],
      };
      await writeFile(
        remotePath,
        JSON.stringify({
          refs: { 'refs/heads/main': baseSha },
          commits: { [baseSha]: baseCommit },
          branchWrites: 0,
          branchEffects: 0,
        }),
      );

      try {
        const crashed = await runWorker(mode, remotePath);
        expect(crashed.code, crashed.stderr).toBe(exitCode);
        const resumed = await runWorker('resume', remotePath);
        expect(resumed.code, resumed.stderr).toBe(0);
        expect(resumed.stdout).toMatch(/^BRANCH:/m);

        const remote = JSON.parse(await readFile(remotePath, 'utf8')) as RemoteState;
        const branches = Object.entries(remote.refs).filter(([ref]) => ref !== 'refs/heads/main');
        expect(branches).toHaveLength(1);
        expect(remote.branchEffects).toBe(1);
        expect(remote.commits[branches[0]![1]]?.parents).toEqual([{ sha: baseSha }]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function runWorker(mode: string, remotePath: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath, mode, remotePath], {
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
