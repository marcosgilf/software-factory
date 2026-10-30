# ADR 0002 — Single device-owned durable backend

**Status:** Accepted for initial implementation

One Hono process owns Pi Durable 1.4.0 sessions and their SQLite stores; clients connect over typed HTTP/SSE. Pin the compatible runtime API and Node 22.19 minimum. Durable tasks own checkpoints, while external writes require a stable idempotency key and remote reconciliation before the result checkpoint. Cloud migration preserves the API and single-writer ownership. Defer multi-device federation.
