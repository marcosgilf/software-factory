# Implementation plan — v0.2

## Milestone 0 — Repository foundation

- [ ] pnpm TypeScript workspace with `apps/web`, `apps/api`, and four packages.
- [ ] TS solution references and buildable package configurations.
- [ ] Astro and Hono smoke tests; Oxlint, Oxfmt, Lefthook; GitHub Actions CI.
- [ ] ADRs and `AGENTS.md` kept current.

**Exit:** clean install, build, typecheck, lint, format check and tests pass on CI.

## Milestone 1 — Durable runtime spike (priority)

- [ ] Pin and verify a compatible Pi Durable version/API.
- [ ] Reproduce upstream task, recovery and late-join examples using offline/faux model.
- [ ] SQLite persisted task survives process restart.
- [ ] Reopen session and reconnect client without duplicate side effects.
- [ ] Per-conversation execution environment with explicit isolation limitations.

**Exit:** automated crash/restart test proves resumed progress and no duplicate external write under an idempotent mock adapter.

## Milestone 2 — Device API and UI

- [ ] Hono session/task endpoints with typed contracts.
- [ ] Snapshot + SSE incremental event stream, resync and authorization.
- [ ] Astro session and task inspector with approval controls.

**Exit:** browser can reconnect during active execution and recover accurate state.

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
