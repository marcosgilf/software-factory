import { readFile, writeFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  createRegistry,
  defineExtension,
  defineTask,
  type TaskId,
} from '@earendil-works/pi-durable';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openAgentHarness } from '../../src/harness.js';
import {
  MOCK_OPERATION_KEY,
  MOCK_RECEIPT_PREFIX,
  RECOVERY_WORKER_MODE,
} from './recovery-protocol.js';

type EffectState = { phase: 'reconcile'; key: string };
type RemoteState = {
  records: Record<string, string>;
  lookupCalls: number;
  createCalls: number;
  effects: number;
};

const [mode, databasePath, remotePath, existingTaskId] = process.argv.slice(2);
if (mode !== RECOVERY_WORKER_MODE.crash && mode !== RECOVERY_WORKER_MODE.resume) {
  throw new Error(`Unknown worker mode: ${mode}`);
}
if (databasePath === undefined || remotePath === undefined)
  throw new Error('Worker paths are required.');

const context = BACKGROUND_CONTEXT;
const remote = {
  async find(key: string) {
    try {
      const state = JSON.parse(await readFile(remotePath, 'utf8')) as RemoteState;
      state.lookupCalls += 1;
      await writeFile(remotePath, JSON.stringify(state));
      return state.records[key];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  async create(key: string) {
    let state: RemoteState = { records: {}, lookupCalls: 0, createCalls: 0, effects: 0 };
    try {
      state = JSON.parse(await readFile(remotePath, 'utf8')) as RemoteState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const receipt = `${MOCK_RECEIPT_PREFIX}${key}`;
    state.createCalls += 1;
    if (state.records[key] === undefined) {
      state.records[key] = receipt;
      state.effects += 1;
    }
    await writeFile(remotePath, JSON.stringify(state));
    return state.records[key]!;
  },
};

const ReconcileEffect = defineTask<
  { key: string },
  EffectState,
  { receipt: string; reconciled: boolean }
>({
  name: 'factory.test.reconcile-effect',
  version: 1,
  initial: (input) => ({ phase: 'reconcile', key: input.key }),
  phases: {
    reconcile: async (task, runtime, taskContext) => {
      const key = task.state.checkpoint.key;
      const knownReceipt = await remote.find(key);
      const receipt = knownReceipt ?? (await remote.create(key));

      // Exit after the remote write to leave SQLite at the prior checkpoint,
      // reproducing a process loss before the completion commit.
      if (mode === RECOVERY_WORKER_MODE.crash && knownReceipt === undefined) process.exit(73);

      await runtime.commit(
        () => ({
          status: 'terminal',
          outcome: {
            status: 'completed',
            result: { receipt, reconciled: knownReceipt !== undefined },
          },
        }),
        taskContext,
      );
    },
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: 'factory.test.recovery', tasks: [ReconcileEffect] }));
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const harness = await openAgentHarness(databasePath, { models, registry }, context);

try {
  if (mode === RECOVERY_WORKER_MODE.crash) {
    const taskId = await (
      await harness.root(context)
    ).commit(
      (tx) =>
        tx.createTask(
          ReconcileEffect,
          { key: MOCK_OPERATION_KEY },
          { ownership: { kind: 'conversation' } },
        ),
      context,
    );
    await new Promise<void>((resolve) => process.stdout.write(`TASK:${taskId}\n`, resolve));
    harness.resume();
    await harness.waitForIdle(context);
  } else {
    if (existingTaskId === undefined) throw new Error('Task ID is required when resuming.');
    harness.resume();
    await harness.waitForIdle(context);
    const result = await harness.getTask(existingTaskId as TaskId, context);
    if (result === undefined)
      throw new Error(`Task ${existingTaskId} disappeared during recovery.`);
    console.log(`RESULT:${JSON.stringify(result.state.outcome)}`);
  }
} finally {
  await harness.close(context);
}
