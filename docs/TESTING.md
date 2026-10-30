# Testing strategy

- Static: pnpm lockfile consistency, `tsc --build`, `astro check`, Oxlint and Oxfmt.
- Unit: contracts, task transitions, deduplication and policy decisions.
- Integration: SQLite open/reopen, task resume, event snapshots, SSE reconnect, mock CLI adapters.
- Failure injection: crash before/after external write and before/after checkpoint; reconcile without duplicate PR or issue.
- Security: agent shell cannot read PATs; unauthorized sessions and writes denied; no sensitive logs.
- End-to-end: ticket -> approved PR with deterministic fake model before live model credentials.
