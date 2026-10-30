# ADR 0001 — pnpm workspace and TypeScript boundaries

**Status:** Accepted for initial implementation

Use native pnpm workspace scripts and TypeScript project references for buildable packages and the
Hono API. The root solution graph builds `packages/contracts`, `packages/agent-runtime`,
`packages/integrations`, `packages/workflows`, and `apps/api` in dependency order. Astro stays
outside that graph and runs `astro check` and `astro build` through its own package scripts.

Local package dependencies use `workspace:*`; library packages expose explicit `exports` maps.
Oxlint, Oxfmt, and Lefthook provide local quality checks, and GitHub Actions runs the same checks on
pull requests and pushes to `main`. Use pnpm directly for workspace scripts; defer Turborepo until
there is a measured need for task caching or orchestration.
