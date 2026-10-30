# Security baseline

- Keep repository free of PATs, keys and `.env` files; use narrowly scoped credentials in backend-only environment.
- Protect all `/api/*` session routes with the backend's `FACTORY_API_TOKEN`; keep it in a secret manager or process environment and restrict network access. This device token is separate from provider API keys and GitHub PATs.
- Separate untrusted agent shell from privileged integration adapters; do not assume `cwd` provides isolation.
- Fail closed on approval, authentication, authorization and credential failures.
- Require explicit approval and remote reconciliation for non-idempotent writes.
- Redact logs, tool outputs and telemetry; never stream secrets to the browser.
- The inspector keeps the device token in tab memory, sends it only in the `Authorization` header, and does not persist it. API logs exclude headers and query strings; task summaries omit inputs, checkpoints, outcomes and error payloads.
- Restrict remote access (private networking initially), validate webhook signatures, apply rate limits and CSRF protections where relevant.
- Test prompt injection, path traversal, cross-session access, replay and crash windows.
