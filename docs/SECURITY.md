# Security baseline

- Keep repository free of PATs, keys and `.env` files; use narrowly scoped credentials in backend-only environment.
- Protect all `/api/*` session routes with the backend's `FACTORY_API_TOKEN`; keep it in a secret manager or process environment and restrict network access. This device token is separate from provider API keys and GitHub PATs.
- Separate untrusted agent shell from privileged integration adapters; do not assume `cwd` provides isolation.
- The local mock issue executor uses a pinned Docker image, no network, a non-root UID, a read-only root filesystem, resource limits, and only a per-task workspace mount. It does not mount the Docker socket or pass provider credentials. The host Docker daemon remains privileged; this mock runner does not provide a complete boundary against container-runtime vulnerabilities.
- Real GitHub mode accepts one configured target only when it is in the backend repository allowlist. Keep its fine-grained PAT in the API process; grant only metadata/issues read and contents/pull-requests write for that repository. Pass no GitHub credentials through `IssueWorkspaceExecutor`, Docker, model tools, or request logs. The branch publisher fixes the target repo, default base and branch prefix, and only publishes bounded regular text files.
- Fail closed on approval, authentication, authorization and credential failures.
- Require explicit approval and remote reconciliation for non-idempotent writes.
- Redact logs, tool outputs and telemetry; never stream secrets to the browser.
- The inspector keeps the device token in tab memory, sends it only in the `Authorization` header, and does not persist it. API logs exclude headers and query strings; task summaries omit inputs, checkpoints, outcomes and error payloads.
- Bind the device API to loopback by default. For remote access, require HTTPS or an encrypted tunnel; never send its bearer token over non-loopback HTTP. Validate webhook signatures, apply rate limits and CSRF protections where relevant.
- Test prompt injection, path traversal, cross-session access, replay and crash windows.
