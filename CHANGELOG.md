# Changelog

## [Unreleased]

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
