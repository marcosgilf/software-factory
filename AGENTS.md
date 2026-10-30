# Repository instructions

Use this file with `ARCHITECTURE.md`, `PLAN.md`, and the documents in `docs/` as the source of
project guidance. Keep changes within the active milestone and update the plan when milestone work
is completed.

## Workspace and checks

- Use Node.js 22 or later and the pinned pnpm version. Keep the pnpm lockfile checked in and use
  `workspace:*` for dependencies between local packages.
- Build packages and the Hono API through the root TypeScript project references. Keep the Astro
  app outside that graph; run `astro check` and `astro build` through its package scripts.
- Keep package entry points explicit in each library's `exports` map. Do not add Turborepo.
- Before opening a PR, run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and
  `pnpm test`.

## Security and scope

- Follow `docs/SECURITY.md`: no committed credentials or `.env` files, and no secrets in client,
  agent shell, transcripts, or logs.
- Keep agent-controlled execution separate from privileged integrations; a working directory alone
  is not a security boundary.
- Fail closed on authentication, authorization, approval, or credential failures when those flows
  are introduced.
- Prefer small, testable vertical slices. Do not add distributed coordination, arbitrary privileged
  shell access, or infrastructure outside the active milestone.
