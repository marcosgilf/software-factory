# Upstream implementation review

## References

- [Pi Durable examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples): native `defineTask` checkpointing, SQLite reopen, late-join watch, coding tools, per-conversation ExecutionEnv.
- [durable-pi](https://github.com/disler/durable-pi): device-owned backend and thin remote clients; adopt stable session/device API and reconnection, defer multi-device federation.
- [pi-durable-news-agent](https://github.com/disler/pi-durable-news-agent): event-triggered proactive workflows with deterministic gates and agent judgment; avoid premature distributed scheduling.

## Acceptance examples

- `11-tasks.ts`: durable phase transitions.
- `12-recovery.ts`: reopen SQLite and resume, with replay-safe effects.
- `20-late-join.ts`: attach while task runs and obtain current view.
- `25-coding-agent.ts`: working-directory-aware coding tools.
- `28-sandbox-per-conversation.ts`: select ExecutionEnv by conversation; note directory isolation is insufficient for security.

Do not copy example applications as production security baselines. Verify current upstream API before integration.

## M1 verification

- Pin `@earendil-works/pi-durable` and its companion `@earendil-works/chord` / `@earendil-works/pi-ai` packages to 1.4.0. The published package metadata requires Node.js 22.19 or later.
- The integration uses the published `Harness.open`, `openNodeSqliteStorage`, `defineTask`, `runtime.commit`, `Conversation.watch` and `ExecutionEnv` types. The offline faux provider and the Node SQLite adapter are exercised in tests; no provider credentials are required.
- Upstream examples establish the recovery and late-join patterns. Local tests additionally force a child process to exit after the mock remote write and before the final SQLite commit, then reopen the same SQLite file and reconcile by idempotency key.
