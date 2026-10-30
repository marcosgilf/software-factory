# Device API and inspector

The Hono API is the single process owner for the local session catalog and active Pi Durable
harnesses. Set `FACTORY_API_TOKEN` in the API process environment before using any `/api/*` route.
The token is a device-level access credential for the inspector; it is not a model API key or a
GitHub PAT. Every valid token can inspect every session on that device, so keep the API on a trusted
private network and rotate the token through the process environment.

Session databases live in `.factory/sessions` under the API working directory by default. Set
`FACTORY_DATA_DIR` to a dedicated private directory to store them elsewhere.

`/health` is public and reports only service availability. Session routes fail closed with `503`
when no API token is configured and `401` when the bearer token is missing or invalid. Requests use
`Authorization: Bearer <token>`. The server logs method, path, status and duration only; it does not
log query strings, headers, request bodies, task payloads or streamed data.

## Endpoints

| Method | Path                                     | Response                                          |
| ------ | ---------------------------------------- | ------------------------------------------------- |
| `GET`  | `/api/sessions`                          | Typed list of session summaries                   |
| `POST` | `/api/sessions`                          | Create a durable session and return its summary   |
| `GET`  | `/api/sessions/:sessionId`               | Session summary                                   |
| `GET`  | `/api/sessions/:sessionId/tasks`         | Safe summaries for tasks in the session           |
| `GET`  | `/api/sessions/:sessionId/tasks/:taskId` | Safe summary for one task                         |
| `GET`  | `/api/sessions/:sessionId/events`        | Snapshot and incremental full-snapshot SSE events |

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

The Astro client uses `fetch` instead of native `EventSource` because it must send the device bearer
token and `Last-Event-ID` headers. The token is held only in tab memory and is never stored in
browser storage or placed in a URL. The API allows browser origins `http://localhost:4321` and
`http://127.0.0.1:4321` by default; set `FACTORY_ALLOWED_ORIGINS` to a comma-separated list when
serving the inspector from a different trusted origin.
