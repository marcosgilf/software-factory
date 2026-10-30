# Software Factory

Local-first, durable AI software factory built with Pi Durable, Hono, Astro, and TypeScript. This
repository is the implementation source of truth.

## Development

Requires Node.js 26.13.0 or later and pnpm 12.16.1.

```sh
pnpm install
pnpm dev
```

The web app runs on Astro's local development server and the API listens on port 3000 by default.
Use `pnpm dev:web` or `pnpm dev:api` to start either app separately; set `PORT` to change the API
port.

| Command                    | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `pnpm typecheck`           | Build referenced TypeScript projects and run `astro check`       |
| `pnpm build`               | Run type checks and build the Astro site                         |
| `pnpm lint`                | Run Oxlint                                                       |
| `pnpm format`              | Format files with Oxfmt                                          |
| `pnpm format:check`        | Check formatting without changing files                          |
| `pnpm check:dependencies`  | Check workspace dependency ranges for newer patch/minor releases |
| `pnpm update:dependencies` | Update workspace dependency ranges to newer patch/minor releases |
| `pnpm test`                | Run Vitest unit, API/SSE and SQLite recovery tests               |

Dependency commands cover the root and all pnpm workspaces, excluding the pinned package manager.
They stay within the current major version; major upgrades need a deliberate change. After
`pnpm update:dependencies`, run `pnpm install` to refresh the lockfile. Lefthook checks commit
messages against Conventional Commits before accepting a commit, and CI checks pull request commit
messages as well.

## Workspace

- `apps/web` — Astro browser client
- `apps/api` — Hono API and server entry point
- `packages/contracts` — shared API types
- `packages/agent-runtime` — Pi Durable SQLite harness, recovery and conversation workspaces
- `packages/integrations` — integration type boundary
- `packages/workflows` — workflow type boundary

The four library packages and Hono API use TypeScript project references. Astro is checked and built
separately. Local package dependencies use `workspace:*`; package exports define each library's
public entry point. The workspace uses pnpm scripts and does not use Turborepo.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Implementation plan](PLAN.md)
- [Durable runtime spike](docs/DURABLE_RUNTIME.md)
- [Device API and inspector](docs/DEVICE_API.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Upstream references](docs/REVIEW_UPSTREAM.md)
- [Codex instructions](AGENTS.md)

Initial implementation work is tracked in GitHub issues. Do not commit production credentials or
`.env` files.
