# AGENTS.md

## Repo shape

Single-file library (`index.ts`) published to npm as `pi-tool-masking`. No build step — TypeScript is consumed directly (`noEmit: true`, `moduleResolution: nodenext`, `exports` and `main` point to `index.ts`). No linter, typechecker, or formatter scripts exist.

## Test

```bash
npm test          # vitest run
npm run test:watch  # vitest (watch mode)
```

Tests live in `__tests__/` (`core.test.ts`, `registry-convergence.test.ts`). Testing uses a custom `MockPI` class (`__tests__/mock-pi.ts`) implementing a subset of `ExtensionAPI` (`setActiveTools`, `getActiveTools`, `appendEntry`, `on`, `events`, `sessionManager.getBranch()`).

## Release

```bash
node scripts/release.mjs patch|minor|major|<x.y.z>
```

This bumps `package.json`, promotes `[Unreleased]` in `CHANGELOG.md`, commits, tags, publishes to npm, then reinstates `[Unreleased]`. Draft `[Unreleased]` entries must be in `CHANGELOG.md` before running.

Shorter version-bump scripts (`version:patch`, `version:minor`, `version:major`) only bump `package.json` — they do NOT commit, tag, or publish.

## Key public API

| Export | Notes |
|---|---|
| `defineToolset(pi, spec)` | Idempotent re-registration by `spec.id` |
| `setDefaultResolutionMode(pi, mode)` | `"exclusion"` (default) or `"inclusion"` |
| `getDefaultResolutionMode(pi)` | Read current mode |
| `getRegisteredToolsets()` | Pure registry read — no `pi` argument needed |
| `TOOLSET_EVENTS` | `changed`, `restored` |

## Architecture notes

- Registry lives on `globalThis` (`__piToolMaskingRegistry`) — survives `/reload` across module instances.
- Persistence via `pi.appendEntry(persistKey, { enabled })` and `pi.sessionManager.getBranch()`. Restore triggers on `session_start` and `session_tree`.
- `requires` cascade: enable cascades to deps, disable cascades to dependents. Cycle detection at toggle time.
- `emitMemberEvents`: opt into per-member fan-out events for per-tool UI updates.

## Constraints

- `prepublishOnly` runs `npm test` — all tests must pass before `npm publish`.
- No CI workflows, pre-commit hooks, or branch protection rules exist yet.
