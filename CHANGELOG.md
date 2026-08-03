# Changelog

## [1.2.1] - 2026-08-03

### Added

- `before_agent_start` now re-asserts the allowlist while allowlist mode is
  active, undoing BOTH directions of mid-session drift by other extensions'
  reconcilers: force-adds of non-allowlisted tools are removed AND
  force-removals of allowlisted members are restored. Emits `changed` for
  each affected toolset; delta-gated to no-op when nothing drifted. The
  allowlist mask is now computed from ONE shared definition
  (`computeAllowlistDesired`) used by both the session restore path and the
  turn-boundary re-assert, so they cannot drift. Restore/re-assert handlers
  are also installed once per `pi` instance rather than once per toolset.
  Residual: depends on extension load order; a pi-core masking primitive
  is needed for a fully-robust fix.

### Changed

- The `"inclusion"` deprecation warning now fires once per process total,
  not once per entry point (`setDefaultResolutionMode` / `doRestore`).

- Internal helper `mergeToolsetDefaults` (never public — `@internal`
  since 1.2.0, unused by any downstream consumer) was inlined into
  `readMergedToolsetDefaults` and removed from the exports.

## [1.2.0] - 2026-08-02

### Added

- **`toolsetDefaults` settings tier:** durable per-toolset defaults in
  `~/.pi/agent/settings.json` (global) and `.pi/settings.json` (project,
  per-entry override). A toolset's fresh-session default is no longer locked
  to its packaged `spec.defaultEnabled`; users can pin `{ enabled: boolean }`
  under the reserved `toolsetDefaults` key (keyed by the toolset's full
  `persistKey`) without toggling (which writes a session-scoped chat-branch
  entry). The library reads both files itself inside `doRestore`, fresh on
  each `/reload`, so downstream consumers no longer need to reinvent a
  settings reader to inject values into `spec.defaultEnabled` before
  `defineToolset`. Settings pins are honored in both `exclusion` and
  `inclusion` modes, mirroring how chat-branch entries are honored — only
  unpinned toolsets consult mode for the floor.

  New exports: `readMergedToolsetDefaults()`, `readToolsetDefaults(scope)`,
  `writeToolsetDefaults(entries, scope)`, `clearToolsetDefaults(scope)`
  (returns the path the block was removed from, or `null`),
  `getEffectiveDefault(spec, snapshot?)` (tier-2 settings then tier-3
  packaged resolver, mode-agnostic), and `MalformedSettingsError` (thrown
  by mutators on a corrupt settings file — a corrupt file is never
  silently overwritten). Reader never throws; malformed files contribute
  `{}` to the merge. Internal/test helpers `parseToolsetDefaults`,
  `mergeToolsetDefaults`, `setSettingsOverrideForTests`, and
  `setSettingsWriterOverrideForTests` are also exported (`@internal`).

- **`"allowlist"` resolution mode:** a third `DefaultResolutionMode`, the
  correct implementation of the intent `"inclusion"` was reaching for.
  The allowlist is a finite array of toolset ids stored in the branch mode
  entry; the suppression (the complement) is computed by the restore
  handler over all registered toolsets, not stored. While the array is
  active it is a top-tier set-level override: stale per-toolset branch
  entries and `toolsetDefaults` pins are bypassed, so a non-allowlist
  toolset cannot leak on. This resolves the fundamental flaw that
  `"inclusion"` (an unbounded floor) could not guarantee focus's contract
  — the array is finite and branch-persisted, so a toolset registered
  *after* focus was entered is not in it and stays off.

  Restore is atomic and two-phase — the full
  desired active-tools set is applied with a single `setActiveTools` call
  before any per-toolset `restored` event fires, so a companion mirroring
  on `TOOLSET_EVENTS.changed` cannot `appendEntry` mid-loop and desync
  the final state. Non-toolset tools in the current active set are
  preserved (the short-circuit computes a delta, not a rebuild).

  `setDefaultResolutionMode` gains an optional `allowlist` param
  (required when `mode === "allowlist"`; rejected if empty at write time,
  though unregistered ids are allowed for forward references). New export
  `getActiveAllowlist()` reads the live array from module state
  (parameterless, matching `getDefaultResolutionMode()` — the consumer
  call site receives `ExtensionAPI`, which does not expose
  `sessionManager`); the downstream actuation call site consults it to
  keep toolsets registered after focus was entered off. `doRestore`
  mirrors the array into module state from the last mode branch entry; a
  corrupt/missing array recovers to `[]` (fail closed) rather than
  rewriting `mode` to `"exclusion"` (fail open).

- **Tombstone helpers:** `clearToolsetEntry(pi, persistKey, branch)` and
  `clearAllToolsetEntries(pi, branch)` append a `null` tombstone to a
  toolset's chat-branch entry, dedup'd — no-op when the last entry is
  already cleared or the key has no prior entry (never-toggled toolsets
  get no tombstone). Lets a downstream `/tbox defaults restore` tombstone
  the chat-branch tier so settings re-assert, within pi-core's append-only
  `SessionManager`. The `branch` arg is the caller's
  `ctx.sessionManager.getBranch()` snapshot — `ExtensionAPI` exposes
  `appendEntry` but not `sessionManager`, so a `pi`-only signature would
  throw in production. Also added `applyToolsetEnabled(pi, spec, enabled)`
  — applies state via `setActiveTools` and emits `changed` without
  persisting, for the live-apply restore path.

### Changed

- **`doRestore` is null-tombstone-aware.** The per-toolset `persistEntries`
  lookup no longer filters out `b.data != null`; a `null` (or absent
  `enabled`) last entry now falls through to settings → mode floor →
  packaged, beating any stale prior entry. Mode resolution is likewise
  null-tombstone-aware (`branchMode ?? "exclusion"`, no settings fallback
  for mode). Tombstones are not sticky — a later manual toggle appends
  after the tombstone and supersedes it.

- **`setDefaultResolutionMode` validation message** updated to
  `Must be "exclusion", "inclusion", or "allowlist"` so the new mode is
  discoverable from the thrown error.

- **`DefaultResolutionMode`** widened to `"exclusion" | "inclusion" |
  "allowlist"`.

### Deprecated

- **`"inclusion"` resolution mode** is deprecated since this release in
  favor of `"allowlist"`, which is the mode `"inclusion"` should have
  been — a finite, branch-persisted constraint resilient to future
  installs rather than an unbounded floor. Behavior is unchanged through
  the deprecation window; the only new runtime effect is a one-time
  warning per process per entry point (`setDefaultResolutionMode` and
  `doRestore`) when `"inclusion"` is set or restored to. Removal (the
  `"inclusion"` type member, its `setDefaultResolutionMode` acceptance,
  the `doRestore` inclusion floor, and its tests) is scheduled for a
  near-term `1.x` minor — flagged as **Breaking** in the CHANGELOG when
  it lands. Switch focus callers to `"allowlist"` now.

## [1.1.0] - 2026-07-28

### Changed

- **`defineToolset` now throws on tool-name overlap:** no two toolsets may
  claim the same tool name, regardless of source. Previously such overlaps
  were silently accepted and corrupted the library's one-tool-per-toolset
  invariant (a tool name belonged to multiple toolsets, so `_applyDisable`
  removed it regardless of owner, restore was order-dependent, enable became
  a silent no-op, the disable cascade skipped the other owner's dependents,
  and downstream consumers like `pi-tbox` saw focus leaks, mis-attribution,
  and double-counted listings). The guard gathers every collision in a single
  registration into one error naming both colliding toolset ids, the tool's
  `sourceInfo.path`/`source` when the tool is registered, and the
  naming-convention hint. This is **breaking** for any extension pair that
  currently has overlapping toolsets — they were already silently broken, but
  will now see a load-time error on upgrade.

## [1.0.2] - 2026-07-26

### Changed

- Switched package license to MIT for permissive use including proprietary adoption.

## 1.0.0 - 2026-07-25

Initial release of `pi-tool-masking`, a core library for grouping pi tools into toggleable toolsets with persistent state and cross-extension events.

### Added

- `defineToolset(pi, spec)` — idempotent re-registration of a toolset by `spec.id`; returns `{ enable, disable, isEnabled }`.
- `ToolsetSpec` shape with `id`, `label`, `description`, `names`, `persistKey`, `defaultEnabled`, `requires`, and `emitMemberEvents`.
- `setDefaultResolutionMode(pi, mode)` / `getDefaultResolutionMode()` — toggle between `"exclusion"` (default) and `"inclusion"` resolution modes.
- `getRegisteredToolsets()` — pure registry read with no `pi` argument.
- `TOOLSET_EVENTS` — `changed` and `restored` event names for cross-extension notification.
- `ToolsetChangedEvent` with optional `member` for per-tool fan-out when `emitMemberEvents` is set.
- Registry stored on `globalThis` (`__piToolMaskingRegistry`) so registrations survive `/reload` across module instances.
- Persistence via `pi.appendEntry(persistKey, { enabled })` and `pi.sessionManager.getBranch()`, with restore on `session_start` and `session_tree`.
- `requires` dependency cascade: enabling pulls in dependencies, disabling cascades to dependents, with cycle detection at toggle time.
