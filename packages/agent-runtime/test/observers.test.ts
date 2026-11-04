import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, LiveDoc, type LiveState } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { openAgentHarness } from '../src/harness.js';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('Pi Durable late observers', () => {
  it('gives a joining observer the current state and later task updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-observer-'));
    const context = BACKGROUND_CONTEXT;
    const modelEntered = signal();
    const modelGate = signal();
    const observedCompletion = signal();
    let harness: Awaited<ReturnType<typeof openAgentHarness>> | undefined;
    let stopWatch: (() => Promise<unknown>) | undefined;

    const faux = fauxProvider();
    const fauxModel = faux.models[0];
    faux.setResponses([
      async () => {
        modelEntered.resolve();
        await modelGate.promise;
        return fauxAssistantMessage(fauxText('Finished after the observer joined.'));
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    try {
      harness = await openAgentHarness(
        join(directory, 'session.sqlite'),
        { models, registry: createRegistry() },
        context,
      );
      const conversation = await harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: { model: { provider: fauxModel.provider, modelId: fauxModel.id } },
        },
        context,
      );
      const submission = await conversation.submit(
        { type: 'input', content: 'Pause while I join.' },
        context,
      );
      const settledSubmission = submission.wait(context);
      await modelEntered.promise;

      const watch = await conversation.watch(context);
      stopWatch = () => watch.stop();
      const initialState = watch.value.docs[LiveDoc.definition.kind] as LiveState;
      expect(initialState.run).toBeDefined();
      watch.start(async (call) => {
        if (call.kind !== 'value') return;
        const live = call.value.docs[LiveDoc.definition.kind] as LiveState;
        if (live.run === undefined) observedCompletion.resolve();
      });

      modelGate.resolve();
      await settledSubmission;
      await harness.waitForIdle(context);
      await observedCompletion.promise;
      await watch.stop();
      stopWatch = undefined;
    } finally {
      modelGate.resolve();
      if (stopWatch !== undefined) await stopWatch();
      if (harness !== undefined) await harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
