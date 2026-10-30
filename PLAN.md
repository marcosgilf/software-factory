# Implementation plan — v0.2

## Milestone 0 — Repository foundation

- [x] pnpm TypeScript workspace with `apps/web`, `apps/api`, and four packages.
- [x] TS solution references and buildable package configurations.
- [x] Astro and Hono smoke tests; Oxlint, Oxfmt, Lefthook; GitHub Actions CI.
- [x] ADRs and `AGENTS.md` kept current.

**Exit:** clean install, build, typecheck, lint, format check and tests pass on CI.

## Milestone 0.1 — Dependency and commit hygiene

- [x] Add npm-check-updates scripts for checking/updating root and workspace dependency ranges.
- [x] Enforce Conventional Commits with commitlint in Lefthook and GitHub Actions.
- [x] Document the update workflow and keep architecture guidance current.

**Exit:** CI dependency drift check passes, and invalid commit messages are rejected.

## Milestone 1 — Durable runtime spike (priority)

- [x] Pin and verify Pi Durable 1.4.0 and its Node 22.19+ API.
- [x] Reproduce native task and late-join patterns with the offline/faux model.
- [x] SQLite-persisted task survives process restart.
- [x] Reopen session and reconcile an existing external effect by idempotency key.
- [x] Resolve a per-conversation execution environment and document its security limits.

**Exit:** automated crash/restart tests prove resumed progress and one mock external write after reconciliation.

## Milestone 2 — Device API and UI

- [x] Hono session/task endpoints with typed contracts.
- [x] Snapshot + SSE incremental event stream, resync and authorization.
- [x] Astro session and task inspector for safe status summaries.

**Exit:** tested browser event handling and Hono SSE replay recover accurate durable task state after a disconnect without stopping the task.

## Milestone 3 — Safe integration and ticket-to-PR

- [ ] Scoped PAT-backed adapter with minimal env and redacted telemetry.
- [ ] Approval state machine and remote write reconciliation.
- [ ] GitHub issue -> isolated workspace -> tests -> PR workflow.

**Exit:** human-approved PR created once despite simulated restart at critical points.

## Milestone 4 — Proactive workflow

- [ ] Alert -> deterministic gate -> durable task -> issue/PR.
- [ ] Webhook deduplication and event provenance.
- [ ] OpenTelemetry traces and recovery runbook.

## Milestone 5 — Remote/cloud

- [ ] Private remote access, authz, backup/restore drill.
- [ ] Terraform and Docker Compose VM deployment.
- [ ] Decide local/cloud ownership and migration process.

## Deferred

Turborepo, multi-device hub, distributed queues, multi-tenant scaling, arbitrary autonomous privileged shell access.
