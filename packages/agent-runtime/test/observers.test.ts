import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTool,
  LiveDoc,
  type LiveState,
} from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { openAgentHarness } from '../src/harness.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAUSE_TOOL_NAME = 'pause';

describe('Pi Durable late observers', () => {
  it('gives a joining observer the current state and later task updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-observer-'));
    const context = BACKGROUND_CONTEXT;
    let signalToolEntered!: () => void;
    let releaseTool!: () => void;
    let signalFinished!: () => void;
    const toolEntered = new Promise<void>((resolve) => (signalToolEntered = resolve));
    const toolGate = new Promise<void>((resolve) => (releaseTool = resolve));
    const observedCompletion = new Promise<void>((resolve) => (signalFinished = resolve));
    let harness: Awaited<ReturnType<typeof openAgentHarness>> | undefined;
    let stopWatch: (() => Promise<unknown>) | undefined;

    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: 'factory.test.pause',
        tools: [
          defineTool({
            name: PAUSE_TOOL_NAME,
            description: 'Wait until a test observer attaches.',
            parameters: Type.Object({}),
            execute: async () => {
              signalToolEntered();
              await toolGate;
              return {};
            },
          }),
        ],
      }),
    );

    const faux = fauxProvider();
    const fauxModel = faux.models[0];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(PAUSE_TOOL_NAME, {}, { id: 'pause-call' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxText('Finished after the observer joined.')),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    try {
      harness = await openAgentHarness(
        join(directory, 'session.sqlite'),
        { models, registry },
        context,
      );
      const conversation = await harness.root(context, {
        agent: { model: { provider: fauxModel.provider, modelId: fauxModel.id } },
      });
      const submission = await conversation.submit(
        { type: 'input', content: 'Pause while I join.' },
        context,
      );
      await toolEntered;

      const watch = await conversation.watch(context);
      stopWatch = () => watch.stop();
      const initialState = watch.value.docs[LiveDoc.definition.kind] as LiveState;
      expect(initialState.run).toBeDefined();

      watch.start(async (value) => {
        const live = value.docs[LiveDoc.definition.kind] as LiveState;
        if (live.run === undefined) signalFinished();
      });

      releaseTool();
      await submission.wait(context);
      await harness.waitForIdle(context);
      await observedCompletion;
      await watch.stop();
      stopWatch = undefined;
    } finally {
      releaseTool();
      if (stopWatch !== undefined) await stopWatch();
      if (harness !== undefined) await harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
