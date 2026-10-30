# ADR 0002 — Single device-owned durable backend

**Status:** Accepted for initial implementation

One Hono process owns Pi Durable sessions and their SQLite stores; clients connect over typed HTTP/SSE. Durable tasks own checkpoints, while external writes require idempotency or reconciliation. Cloud migration preserves the API and single-writer ownership. Defer multi-device federation.
