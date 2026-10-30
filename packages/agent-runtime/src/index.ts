declare const sessionIdBrand: unique symbol;

export type SessionId = string & { readonly [sessionIdBrand]: true };

export interface SessionSummary {
  readonly id: SessionId;
  readonly status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
}

export { openAgentHarness } from './harness.js';
export type { AgentHarness } from './harness.js';
export {
  assignConversationWorkspace,
  conversationWorkspaceDoc,
  nodeExecutionEnvForConversation,
} from './workspace.js';
