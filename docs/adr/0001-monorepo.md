# ADR 0001 — pnpm workspace and TypeScript boundaries

**Status:** Accepted for initial implementation

Use native pnpm workspace scripts and TypeScript project references for buildable packages and API. Astro runs its own checks. Enforce import boundaries through exports and lint rules. Defer Turborepo until measurable need.
