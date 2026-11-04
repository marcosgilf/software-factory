# Device API and inspector

The Hono API is the single process owner for the local session catalog and active Pi Durable
harnesses. It binds to `127.0.0.1` by default and does not terminate TLS. Set `FACTORY_API_TOKEN`
in the API process environment before using any `/api/*` route.
The token is a device-level access credential for the inspector; it is not a model API key or a
GitHub PAT. Every valid token can inspect every session on that device, so keep the API on loopback
or behind encrypted remote access and rotate the token through the process environment.

Session databases live in `.factory/sessions` under the API working directory by default. Set
`FACTORY_DATA_DIR` to a dedicated private directory to store them elsewhere.

`/health` is public and reports only service availability. Session routes fail closed with `503`
when no API token is configured and `401` when the bearer token is missing or invalid. Requests use
`Authorization: Bearer <token>`. The server logs method, path, status and duration only; it does not
log query strings, headers, request bodies, task payloads or streamed data.

## Endpoints

| Method | Path                                              | Response                                          |
| ------ | ------------------------------------------------- | ------------------------------------------------- |
| `GET`  | `/api/sessions`                                   | Typed list of session summaries                   |
| `POST` | `/api/sessions`                                   | Create a durable session and return its summary   |
| `GET`  | `/api/sessions/:sessionId`                        | Session summary                                   |
| `GET`  | `/api/sessions/:sessionId/tasks`                  | Safe summaries for tasks in the session           |
| `GET`  | `/api/sessions/:sessionId/tasks/:taskId`          | Safe summary for one task                         |
| `POST` | `/api/sessions/:sessionId/workflows/issue-to-pr`  | Start issue-to-PR task                            |
| `GET`  | `/api/sessions/:sessionId/tasks/:taskId/approval` | Approval progress and completed PR URL            |
| `POST` | `/api/sessions/:sessionId/tasks/:taskId/approval` | Approve or reject an issue-to-PR task             |
| `GET`  | `/api/sessions/:sessionId/events`                 | Snapshot and incremental full-snapshot SSE events |

Summaries include IDs, task kind, lifecycle status and timestamps. Inputs, checkpoints, outcomes,
transcripts, provider credentials and task error details stay in the backend.

## SSE reconnect behavior

Each stream begins with a `snapshot` event containing a complete safe session snapshot. Visible task
state changes produce `update` events, also with complete snapshots. Event IDs are
`<process-epoch>/<session-id>/<sequence>` and increase for each event. The API retains the latest
128 events per session while the process is running.

Reconnect with `Last-Event-ID` set to the last event processed by the client. A cursor within the
retained history replays newer events. A malformed, expired, future or previous-process cursor
produces a `resync` event with the current full snapshot. Every event carries a full snapshot, so the
client reducer can ignore stale revisions and recover directly from a resync.

The issue-to-PR routes are configured with `FACTORY_ISSUE_TO_PR_MODE=mock` or `github`. Mock mode
accepts issue `42` as eligible, issue `43` without the required label, and closed issue `44`. Its
executor uses a pinned Node image in Docker with no network, a non-root UID, the default seccomp
profile, a read-only root filesystem, and one temporary workspace mount. It runs one deterministic
test, then deletes that workspace. It receives no GitHub credential or Docker socket. The mock
GitHub adapter makes no network calls and does not create a real PR.

## Real GitHub adapter (PR A)

Inject these variables into the API process. Store `FACTORY_GITHUB_TOKEN` in a secret manager; do not
put it in a committed file, browser, Docker container, agent environment or command transcript.

| Variable                              | Required value                                            |
| ------------------------------------- | --------------------------------------------------------- |
| `FACTORY_ISSUE_TO_PR_MODE`            | `github`                                                  |
| `FACTORY_GITHUB_TOKEN`                | Fine-grained PAT, backend only                            |
| `FACTORY_GITHUB_REPOSITORY`           | One target such as `owner/repo`                           |
| `FACTORY_GITHUB_DEFAULT_BRANCH`       | Exact base branch, such as `main`                         |
| `FACTORY_GITHUB_ALLOWED_REPOSITORIES` | Comma-separated repository allowlist; must include target |

Scope the PAT to the target repository. Give it metadata read, issues read, contents write and pull
requests write permissions only. Keep API bound to loopback. `FACTORY_API_TOKEN` remains separate.
The API does not accept a repository or base-branch override from a request.

The publisher creates only a deterministic `factory/issue-<operation-hash>` branch. It allows up to
100 UTF-8 add/modify files and 1 MB total, with regular-file mode only; it cannot delete files or
create executable, symlink or submodule entries. It rejects path traversal, `.git`, `.github`,
environment files and common credential-file suffixes. It requires the configured base
SHA to remain current immediately before creating the ref. A retry accepts an existing branch only
when commit parent, tree, change digest and operation marker match. A failure before ref creation can
leave unreachable Git objects, but it does not create a visible branch. Pull requests must use the
generated branch and configured base.

PR A configures the real adapter and publisher, but does not include a coding executor. In `github`
mode, the API can read an issue and apply the label gate; an eligible task then fails closed before
workspace execution. It does not publish a branch or create a PR. PR B will add isolated code changes
and approval bound to the resulting commit.

### Adapter-only operator runbook

1. Create a fine-grained PAT for the configured repository with the permissions above.
2. Store the PAT and `FACTORY_API_TOKEN` in a secret manager. Inject them into the API process; do not
   put either value in a command, `.env` file, browser or log.
3. Set target and allowlist, then start the API:

   ```sh
   FACTORY_ISSUE_TO_PR_MODE=github \
   FACTORY_GITHUB_REPOSITORY=owner/repo \
   FACTORY_GITHUB_DEFAULT_BRANCH=main \
   FACTORY_GITHUB_ALLOWED_REPOSITORIES=owner/repo \
   pnpm dev:api
   ```

4. Use the authenticated issue-to-PR start route to verify issue lookup and the required-label gate.
   An eligible task must end as `failed` in this PR because no coding executor is configured. No
   branch or PR is created.
5. Stop the API with `SIGINT` or `SIGTERM`. Revoke the PAT in GitHub and remove it from the secret
   manager when integration access is no longer needed.

The Astro client uses `fetch` instead of native `EventSource` because it must send the device bearer
token and `Last-Event-ID` headers. The token is held only in tab memory and is never stored in
browser storage or placed in a URL. The client allows plain HTTP only for loopback API URLs. For
remote access, use an HTTPS reverse proxy or an encrypted tunnel that forwards to loopback; do not
send the bearer token over non-loopback HTTP. The API allows browser origins `http://localhost:4321`
and `http://127.0.0.1:4321` by default; set `FACTORY_ALLOWED_ORIGINS` to a comma-separated list
when serving the inspector from a different trusted origin.

## Local mock issue-to-PR test

Start Docker and load the pinned image once, then start the API with a local-only token and mock
workflow mode:

```sh
docker pull node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
FACTORY_API_TOKEN=local-test-token FACTORY_ISSUE_TO_PR_MODE=mock pnpm dev:api
```

Create a session, start issue `42`, then poll its approval status until it is `pending`:

```sh
API=http://127.0.0.1:3000
TOKEN=local-test-token
SESSION=$(curl -fsS -X POST "$API/api/sessions" -H "Authorization: Bearer $TOKEN" | jq -r '.session.id')
TASK=$(curl -fsS -X POST "$API/api/sessions/$SESSION/workflows/issue-to-pr" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"issueNumber":42}' | jq -r '.task.id')
curl -fsS "$API/api/sessions/$SESSION/tasks/$TASK/approval" -H "Authorization: Bearer $TOKEN"
```

Approve task and poll until response shows `completed` and a mock `pullRequestUrl`:

```sh
curl -fsS -X POST "$API/api/sessions/$SESSION/tasks/$TASK/approval" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"decision":"approved"}'
curl -fsS "$API/api/sessions/$SESSION/tasks/$TASK/approval" -H "Authorization: Bearer $TOKEN"
```

Use issue `43` to verify the required `factory/approved` label gate. This mock is in memory; use
workflow crash-recovery tests to verify replay across a process restart.
