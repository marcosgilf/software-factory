import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { describe, expect, it } from 'vitest';
import { openAgentHarness } from '../src/harness.js';
import { assignConversationWorkspace, nodeExecutionEnvForConversation } from '../src/workspace.js';

describe('per-conversation execution environments', () => {
  it('resolves independent persisted working directories for two conversations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-workspaces-'));
    const alicePath = join(directory, 'alice');
    const bobPath = join(directory, 'bob');
    const context = BACKGROUND_CONTEXT;

    try {
      await Promise.all([mkdir(alicePath), mkdir(bobPath)]);
      const registry = createRegistry();
      registry.install(CodingTools);
      const faux = fauxProvider();
      const fauxModel = faux.models[0];
      const write = (content: string) =>
        fauxAssistantMessage(fauxToolCall('write', { path: 'note.txt', content }), {
          stopReason: 'toolUse',
        });
      faux.setResponses([
        write('from alice'),
        fauxAssistantMessage('Saved.'),
        write('from bob'),
        fauxAssistantMessage('Saved.'),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const databasePath = join(directory, 'session.sqlite');
      const options = { models, registry, env: nodeExecutionEnvForConversation };
      const conversationIds = await (async () => {
        const harness = await openAgentHarness(databasePath, options, context);
        try {
          const model = { provider: fauxModel.provider, modelId: fauxModel.id };
          const makeConversation = async (cwd: string) =>
            harness.createConversation(
              {
                ownership: { kind: 'ownerless' },
                agent: { model },
                init: (tx, id) => assignConversationWorkspace(tx, id, cwd),
              },
              context,
            );
          const alice = await makeConversation(alicePath);
          const bob = await makeConversation(bobPath);
          return [alice.id, bob.id] as const;
        } finally {
          await harness.close(context);
        }
      })();

      const harness = await openAgentHarness(databasePath, options, context);
      try {
        const alice = await harness.conversation(conversationIds[0], context);
        const bob = await harness.conversation(conversationIds[1], context);
        if (alice === undefined || bob === undefined) {
          throw new Error('Workspace conversations were not persisted.');
        }

        await (
          await alice.submit({ type: 'input', content: 'Write my note.' }, context)
        ).wait(context);
        await (
          await bob.submit({ type: 'input', content: 'Write my note.' }, context)
        ).wait(context);

        expect(await readFile(join(alicePath, 'note.txt'), 'utf8')).toBe('from alice');
        expect(await readFile(join(bobPath, 'note.txt'), 'utf8')).toBe('from bob');
      } finally {
        await harness.close(context);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
