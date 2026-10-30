import { isAbsolute } from 'node:path';
import type { Context } from '@earendil-works/chord';
import {
  defineDoc,
  type ConversationId,
  type HarnessOptions,
  type Tx,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

/** The server-owned working directory assigned to one conversation. */
export const conversationWorkspaceDoc = defineDoc<{ cwd?: string }>({
  checkpointWhen: () => false,
  kind: 'factory.workspace',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
});

/** Store an absolute working-directory path in the conversation's durable metadata. */
export async function assignConversationWorkspace(
  tx: Tx,
  conversationId: ConversationId,
  cwd: string,
) {
  if (!isAbsolute(cwd)) {
    throw new Error('Conversation working directory must be an absolute path.');
  }

  const workspace = await tx.doc(conversationWorkspaceDoc, conversationId);
  workspace.cwd = cwd;
}

/** Resolve each conversation's committed workspace to its own Node environment. */
export const nodeExecutionEnvForConversation: NonNullable<HarnessOptions['env']> = async (
  { conversationId, read },
  context: Context,
) => {
  const workspace = await read.snapshot(conversationWorkspaceDoc, conversationId, context);
  if (workspace?.cwd === undefined) return undefined;

  return new NodeExecutionEnv({ cwd: workspace.cwd });
};
