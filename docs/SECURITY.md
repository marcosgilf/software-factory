# Security baseline

- Keep repository free of PATs, keys and `.env` files; use narrowly scoped credentials in backend-only environment.
- Separate untrusted agent shell from privileged integration adapters; do not assume `cwd` provides isolation.
- Fail closed on approval, authentication, authorization and credential failures.
- Require explicit approval and remote reconciliation for non-idempotent writes.
- Redact logs, tool outputs and telemetry; never stream secrets to the browser.
- Restrict remote access (private networking initially), validate webhook signatures, apply rate limits and CSRF protections where relevant.
- Test prompt injection, path traversal, cross-session access, replay and crash windows.
