# Architecture — v0.2

## Goal

A local-first Software Factory running on a MacBook, remotely accessible through a browser, later portable to a Linux VM. Support ticket-to-PR and alert-to-ticket workflows with human approval and crash recovery.

## Principles

- Lean software: minimize moving parts, implement vertical slices, prefer tested OSS and native primitives.
- Backend owns durable state; clients are replaceable and reconnectable.
- Explicit trust boundaries: agent text is untrusted, shell access is isolated, credentials stay outside agent environments.
- No distributed coordination or Turborepo initially.

## Components

- `apps/web`: Astro UI, initially browser client.
- `apps/api`: Hono device API, HTTP/SSE, authentication and authorization.
- `packages/contracts`: shared typed API/event contracts.
- `packages/agent-runtime`: Pi Durable harness, session lifecycle, SQLite storage and recovery.
- `packages/integrations`: typed CLI/service adapters with scoped PATs.
- `packages/workflows`: native Pi Durable tasks, triggers, approvals and deduplication.
- `infra/terraform`: eventual cloud infrastructure.

## Runtime topology

One Hono backend process on the MacBook owns the session catalog and each active Pi Durable harness. Sessions have independent durable SQLite state; catalog and session ownership are explicit. The web UI is a thin client. Do not introduce horizontal scaling with shared SQLite.

On client connection: return a consistent initial snapshot, then stream incremental updates with reconnect/resync behavior. A dropped SSE connection must not cancel a durable task. Define stable event IDs and replay/resync semantics before implementing the reducer.

## Workflows

Event/webhook -> validate and deduplicate -> deterministic eligibility gate -> durable task -> agent judgment where needed -> approval -> restricted integration -> reconcile external side effect -> record result. Use `defineTask` phases and persisted checkpoints, not an independent workflow engine.

Checkpointing does not make external writes exactly-once. Every non-idempotent operation (e.g. create PR) needs a stable operation key, remote reconciliation, and crash-injection tests.

## Execution security

ExecutionEnv is an abstraction, not a sandbox guarantee. A separate working directory alone does not isolate processes or secrets. Untrusted coding commands require process/container-level isolation and a minimal environment. Never expose PATs to agent shell commands, browser clients, transcripts, or logs. Keep privileged operations behind allowlisted typed adapters and fail-closed approvals.

## Monorepo boundaries

pnpm workspaces, `workspace:*` dependencies, TypeScript project references (`tsc --build`) for buildable packages and Hono API; Astro uses `astro check`/`astro build` outside the root solution graph. Explicit package exports and lint/dependency rules enforce import boundaries; TS references only establish build order and incremental compilation. Oxlint, Oxfmt and Lefthook; no Turborepo.

## Observability

OpenTelemetry instrumentation for task state transitions, tool calls, integration operations and errors; avoid sensitive payloads. Begin with structured logs and local traces, add Grafana-compatible OSS backend as needed.

## Cloud migration

Keep stable device API and session persistence contracts. Later deploy a single backend owner to a VM with Docker Compose, backups, restricted access and Terraform. Multi-device federation is deferred.
