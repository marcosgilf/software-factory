import type { SessionId } from '@factory/agent-runtime';
import type { IntegrationId } from '@factory/integrations';

declare const workflowRunIdBrand: unique symbol;

export type WorkflowRunId = string & { readonly [workflowRunIdBrand]: true };

export interface WorkflowContext {
  readonly runId: WorkflowRunId;
  readonly sessionId: SessionId;
  readonly integrationIds: readonly IntegrationId[];
}
