# Changelog

## [Unreleased]

## 1.0.0

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
