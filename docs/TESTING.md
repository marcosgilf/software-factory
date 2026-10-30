# Testing strategy

- Static: pnpm lockfile consistency, dependency drift, `tsc --build`, `astro check`, Oxlint and
  Oxfmt. Run these with `pnpm check:dependencies`, `pnpm typecheck`, `pnpm lint`, and
  `pnpm format:check`.
- M0 smoke tests: Vitest exercises the Hono `/health` route and Astro app metadata; `astro build`
  compiles the static web app.
- Commit messages: the Lefthook `commit-msg` hook and CI use commitlint with the Conventional
  Commits ruleset.
- Unit: contracts, task transitions, deduplication and policy decisions.
- Integration: Pi Durable SQLite open/reopen, a child-process crash and task resume, late observer snapshots, per-conversation work directories, event snapshots, SSE reconnect and mock CLI adapters.
- Failure injection: crash before/after external write and before/after checkpoint; reconcile without duplicate PR or issue.
- Security: agent shell cannot read PATs; unauthorized sessions and writes denied; no sensitive logs.
- End-to-end: ticket -> approved PR with deterministic fake model before live model credentials.
