# AGENTS.md

## Repo shape

Single-file library (`index.ts`) published to npm as `pi-tool-masking`. No
build step — TypeScript is consumed directly (`noEmit: true`,
`moduleResolution: nodenext`, `exports` and `main` point to `index.ts`,
`files` ships only `index.ts`). No linter or formatter scripts exist.

## Commands

```bash
npm test            # vitest run (CI runs exactly this)
npm run test:watch  # vitest watch
npx tsc --noEmit    # typecheck (not a package script; runs in prepublishOnly)
```

Single test file: `npx vitest run __tests__/core.test.ts`
By name pattern: `npx vitest run -t "restore"`

There is **no `typecheck` npm script**. `prepublishOnly` is
`npm test && npx tsc --noEmit`, so typecheck only gates a publish. Run
`tsc --noEmit` yourself before shipping — the strict tsconfig (see below)
catches things vitest won't.

## Strict TypeScript

`tsconfig.json` enables `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `isolatedModules`, `moduleDetection: force`, on
top of `strict`. Indexed access returns `T | undefined`; optional props can't
be set to `undefined` explicitly. Respect this in new code — typecheck will
fail otherwise.

## Tests

Vitest with **globals on** (`describe`/`it`/`expect` available without import;
`types: ["node", "vitest/globals"]`). `testTimeout: 15_000`.

Tests live in `__tests__/` (`core.test.ts`, `registry-convergence.test.ts`, `custom-entry.test.ts`).
They use a custom `MockPI` class (`__tests__/mock-pi.ts`) implementing a
subset of `ExtensionAPI` (`setActiveTools`, `getActiveTools`, `appendEntry`,
`on`, `events`, `sessionManager.getBranch()`). No external services, no
fixtures, no snapshots.

## CI

`.github/workflows/test.yml` runs `npm ci && npm test` on PRs and pushes to
`main` (Node `lts/*`). **Typecheck is not in CI** — only the publish gate
runs it.

## Release

```bash
node scripts/release.mjs patch|minor|major|<x.y.z>
```

Requires a clean working tree. The script: runs `npm test`, bumps version
(`npm version --no-git-tag-version`), promotes `[Unreleased]` in
`CHANGELOG.md` to `[version] - date`, commits, tags `v<version>`,
`npm publish --access public`, reinstates a fresh `[Unreleased]` section,
commits that, and pushes `main` + the tag to `origin`. Draft `[Unreleased]`
entries in `CHANGELOG.md` before running (the script warns if empty but
proceeds).

The shorter `version:patch|minor|major` scripts only bump `package.json` —
they do NOT test, commit, tag, or publish.

## Key public API

| Export | Notes |
|---|---|
| `defineToolset(pi, spec)` | Idempotent re-registration by `spec.id` |
| `setDefaultResolutionMode(pi, mode, allowlist?)` | `"exclusion"` (default), `"inclusion"` (deprecated since 1.2.0), or `"allowlist"` (requires `allowlist: string[]`) |
| `getDefaultResolutionMode()` | Read current mode (no `pi` argument) |
| `getActiveAllowlist()` | Copy-on-read mirror of the active allowlist, or `undefined` when not in allowlist mode |
| `getRegisteredToolsets()` | Pure registry read — no `pi` argument needed |
| `clearToolsetEntry(pi, persistKey, branch)` / `clearAllToolsetEntries(pi, branch)` | Write a null tombstone (single / all) so restore supersedes stale persisted state |
| `applyToolsetEnabled(pi, spec, enabled)` | Apply a single toggle through the `requires` cascade — live-apply without writing a branch entry (used by tbox) |
| `readToolsetDefaults(scope)` / `readMergedToolsetDefaults()` | Read `toolsetDefaults` from one scope / merged global+project |
| `writeToolsetDefaults(entries, scope)` / `clearToolsetDefaults(scope)` | Mutate / clear `toolsetDefaults` settings |
| `getEffectiveDefault(spec, snapshot?)` | Resolve a toolset's effective default through mode + settings tiers |
| `MalformedSettingsError` | Thrown by reader/writer on unparseable settings JSON |
| `lastCustomEntry<T>(branch, customType)` | Newest custom entry matching `customType`, narrowed through the `"custom"` discriminator so callers get typed `.data` without per-site `any` casts |
| `TOOLSET_EVENTS` | `changed`, `restored` |

`setSettingsOverrideForTests` / `setSettingsWriterOverrideForTests` are test seams, not public API.

## Architecture notes

- Registry lives on `globalThis` (`__piToolMaskingRegistry`) — survives
  `/reload` across module instances. Module state and deprecation-warning
  tracking are also on `globalThis`.
- Persistence via `pi.appendEntry(persistKey, { enabled })` and
  `pi.sessionManager.getBranch()`. Restore triggers on `session_start` and
  `session_tree`; a per-event guard dedupes repeated restore events.
- `before_agent_start` re-asserts the allowlist mask each turn, undoing
  BOTH directions of mid-session drift by other extensions' reconcilers that
  bypass the mask via `pi.setActiveTools` between restore events:
  force-adds of non-allowlisted tools are removed and force-removals of
  allowlisted members are restored. Emits `changed` for each affected
  toolset; delta-gated to no-op when nothing drifted. The mask is computed
  from a single shared helper (`computeAllowlistDesired`) with the session
  restore path so the two never drift. Restore/re-assert handlers install
  once per `pi` instance (WeakSet guard) rather than once per toolset.
  Residual: runs at this extension's load-order position — a
  force-add reconciler on a later-loading extension re-adds after us; a
  fully-robust fix needs a pi-core masking primitive at the
  `setActiveTools` boundary.
- `requires` cascade: enable cascades to deps, disable cascades to
  dependents. Cycle detection at toggle time.
- `emitMemberEvents`: opt into per-member fan-out events for per-tool UI
  updates.
