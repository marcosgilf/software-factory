# Durable runtime spike

M1 pins `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` to
1.4.0. The Pi packages require Node.js 22.19 or later. `packages/agent-runtime` exposes
`openAgentHarness()` to open one harness over a file-backed Node SQLite store.

## Task recovery

Pi Durable task handlers are phase functions. Persist the next checkpoint or terminal outcome with
`runtime.commit()`. A process restart opens the same SQLite file and resumes pending tasks after
`Harness.resume()`. The integration test starts a worker process, lets it write a mock remote record,
then exits the process before the task's completion checkpoint. A second worker opens the same file,
looks up the operation by its stable idempotency key, and records the reconciled receipt without
creating a second remote effect.

SQLite checkpointing alone cannot make a remote write exactly once. If the process stops after the
remote accepts a request but before SQLite records the result, recovery must query the remote system
using the same stable key. Adapters for systems without idempotency or lookup support will need a
separate approval and reconciliation design.

## Observers

`Conversation.watch()` gives a late observer the current view before incremental updates. The test
joins while a faux-model tool call is paused, checks the active task in the initial snapshot, and
receives the settled state after execution resumes. This is a runtime primitive; M1 does not add an
HTTP or SSE transport.

## Conversation workspaces

`conversationWorkspaceDoc` stores a server-assigned absolute working directory per conversation.
`nodeExecutionEnvForConversation` resolves the committed document before providing a
`NodeExecutionEnv`; an unassigned conversation gets no environment. Forked conversations begin
without an assigned directory.

A working directory is not a sandbox. It does not isolate processes, prevent path traversal, or keep
credentials away from shell commands. The M1 tests use only temporary directories and the offline
faux model. Production coding commands still require process or container isolation and a minimal
environment, as described in [Security](SECURITY.md).
