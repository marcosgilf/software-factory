import type { Context } from '@earendil-works/chord';
import { Harness, type HarnessOptions } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

export type AgentHarness = Awaited<ReturnType<typeof Harness.open>>;

/** Opens one Pi Durable harness over its file-backed SQLite store. */
export async function openAgentHarness(
  databasePath: string,
  options: HarnessOptions,
  context: Context,
): Promise<AgentHarness> {
  const storage = await openNodeSqliteStorage(databasePath);
  return Harness.open(storage, options, context);
}
