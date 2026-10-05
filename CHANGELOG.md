# Changelog

## [Unreleased]

This is a breaking release centered on one idea: toggles are a **batch-first,
exclusion-mode-only operation resolved from a branch read at each call's
boundary**. Migration surface: `Toolset.enable`/`.disable` gain a required
`sessionManager` argument (pass `ctx.sessionManager` itself, never a bare
`getBranch` method reference); `applyToolsetEnabled` is renamed
`forceToolsetEnabled`; the `"inclusion"` mode, `getDefaultResolutionMode()`,
`getActiveAllowlist()`, and `ToolsetSpec.description` / `emitMemberEvents` are
gone; test-only internals moved under `__internal`.

### Added

- **`toggleBatch(pi, sessionManager, ops)`** — toggle a batch of toolsets in one
  call; the sole toggle actuation path, with `Toolset.enable`/`.disable` kept as
  one-line single-op wrappers delegating to it. One batch is one coherent
  intent: the pure planner resolves explicit targets plus their `requires`
  cascade closures into a final state per id and returns a flattened
  `ToggleResult[]` delta (an op already in its desired state is absent).
  Refusals are atomic and pre-write: a reachable cycle throws `CycleError`
  (carries `cyclePath`), an incoherent batch (an id enabled while a transitive
  `requires` dep is disabled by the same batch) throws `ContradictionError`, an
  explicit unknown id throws; implied unregistered closure deps are leniently
  skipped, duplicate ops dedupe when consistent and throw when conflicting. Gate
  order: defer → empty `ops` → allowlist refusal → plan → settings snapshot →
  execute. See README for the full contract.
- **Named error classes — `CycleError`, `ContradictionError`,
  `PersistKeyCollisionError`, `AllowlistModeError`.** Catch all four by
  `err?.name`, never `instanceof` (handles may belong to a different physical
  library copy via the shared `globalThis` registry — the setup the registry
  exists to support); messages are diagnostics, never string-matched.
  `PersistKeyCollisionError` is thrown by `defineToolset` when another toolset
  already claims the spec's `persistKey` (previously a plain `Error` with no
  identifying surface); atomic — registration writes nothing.
  `AllowlistModeError` is the allowlist toggle refusal (see Changed); it carries
  `specId` on single-op wrapper refusals and is `undefined` on batch-path
  refusals (the refusal is mode-global and attributes nothing).
  `MalformedSettingsError` deliberately keeps its `instanceof` contract (its
  throwers are same-module imports).
- **`readBranchModeState(branch)`** — the governance decision read shared by
  restore, the resolver, the re-assert dispatcher, and the toggle refusal:
  returns `{ mode, allowlist }` (absent entry → `"exclusion"`; corrupt array
  fails closed → `[]` with non-string members dropped). Copy-on-read in both
  directions — `setDefaultResolutionMode` copies its input before `appendEntry`
  (pi stores entry `data` by reference). For consumer decision/authoring paths
  only — **never** a toggle pre-check: call the toggle and catch
  `AllowlistModeError`.
- **`effectiveEnabled(spec, branch, defaults)`** — exported resolver for a
  toolset's persisted intent: allowlist override → chat-branch entry → settings
  pin → `defaultEnabled ?? true`; returns `{ enabled, persistedEntry }`
  (`persistedEntry` is true only for a boolean `enabled` entry — a `null`
  tombstone or no entry reports `false`). The read side stays mode-dependent by
  design. Consumer rule: display surfaces read intent (`effectiveEnabled`),
  declaration-sensitive surfaces read observation (`isEnabled()`), and nothing
  gates a toggle with it.
- **`isDeferredChild()`** — the env-only defer predicate (`PI_TOOLMASKING_DEFER`
  foreign-pid check, never settings) shared by the re-assert dispatcher and the
  toggle gate, exported so consumers gate their own actuation and
  governance-authoring flows with the identical signal.
- **Actuatable-member filtering.** Loadout writes and masks filter through
  registered, non-`hidden`-exposure tool names (`getActuatableNames`); a
  `hidden`-exposure member can never be active and is never handed to
  `setActiveTools` (on pi builds without `exposure`, all registered names count
  as actuatable). A toolset with zero actuatable members is *inert*: toggles
  persist/emit intent, but `isEnabled()` stays false while `effectiveEnabled()`
  reports the recorded state — pick the right signal.

### Changed

- **Breaking: `Toolset.enable`/`.disable` take a required `sessionManager`
  branch reader and return a change report (`ToggleResult[]`; `[]` = silent
  no-op).** In practice pass `ctx.sessionManager` — the reader object itself,
  never a bare `getBranch` method reference (the `BranchReader` type makes that
  a compile error; an unbound method would throw). The library reads the branch
  once per toggle call, at that call's boundary, so one reader passed once per
  command stays correct across cascades and loops; external branch writes before
  the call are visible by construction. There is no branchless fallback. This
  also fixes the clobbered-active drop: a user's off toggle on a toolset whose
  members were removed from the active set by another extension now persists the
  off entry and emits instead of being silently dropped.
- **Breaking: toggles are an exclusion-mode operation — under allowlist
  governance every toggle throws `AllowlistModeError`, atomically (no branch
  entry, no emit, no loadout write).** This removes the legal-but-incoherent
  allowlist toggle rows (shadowed enables, never-silent repeats, event/report
  disagreement). Immediate actuation under focus is `forceToolsetEnabled`, the
  documented primary actuation path; convergence after a refusal is the per-turn
  re-assert's job. The re-assert's arm selection also joins the branch read, so
  every governance decision in the library reads one source.
- **Breaking: `applyToolsetEnabled` is renamed `forceToolsetEnabled(pi, spec,
  enabled)`.** Same contract — never persists, no cascade, always applies,
  always emits. The `force…` name marks it as the actuation primitive that
  bypasses the intent gate.
- **Breaking: emits moved from per-apply to post-execution.** A `changed`
  listener on a dependency now fires after its dependents are written, so
  `pi.getActiveTools()` observed inside that listener differs from earlier
  releases; no library-emitted event fires until every write in the call has
  completed. Report/emit order is the planner's discovery order (identical to
  the legacy order for every single-op call). Residual: racing writers on
  channels outside the library's events (`prepareLoadout` hooks) can still
  append mid-call; such a write for an id whose intent already matched wins at
  the next restore by last-writer-wins.
- **Breaking: cycle throws are atomic and named.** Previously a cycle detected
  mid-cascade could leave prior cascade writes standing; now `CycleError` is
  thrown by the pure planner before any write or emit. Catch by `err?.name`,
  never message text.
- **Same-value toggles go silent:** persist + emit iff the intent changes **or**
  a loadout write occurred. A toggle whose resolved intent already matches and
  that needs no loadout write returns `[]` (previously every same-value toggle
  on an inert or partially-registered toolset re-persisted and re-emitted).
  Enable-after-clobber stays loud on purpose: the loadout repair fires, so the
  on entry and `changed` emit fire with it. Cascade repeats are silent by
  construction (the planner's visited set yields each id exactly once per call).
- **In a deferring child (`isDeferredChild()`), every public API that implicitly
  writes branch governance state is a silent no-op** (no throw, no write, no
  emit, no notify channel): every toggle returns `[]`,
  `setDefaultResolutionMode` is validate-then-suppress (invalid input still
  throws), and the tombstone helpers write nothing. Deliberate write/actuation
  APIs stay live: `forceToolsetEnabled`, raw `appendEntry`, and the settings
  writers. Gate order is part of the contract (see `toggleBatch`).
- **`defineToolset` reserves the resolution-mode branch key:** a spec whose
  `persistKey` is `"toolset-resolution-mode"` now throws a validation `Error` at
  registration — its `{ enabled }` toggle entries would otherwise supersede the
  branch's resolution-mode entry (and vice versa) via last-writer-wins, silently
  dropping allowlist governance. No legitimate consumer key is affected.

### Removed

- **`getActiveAllowlist()` and `getDefaultResolutionMode()`** — with every
  governance decision reading the branch via `readBranchModeState(branch)`, both
  parameterless mirrors are strictly worse duplicates of the read restore itself
  resolves from (and the parameterless shape is what let consumer guards
  silently pass on a stale read). Migrate decision reads to
  `readBranchModeState(ctx.sessionManager.getBranch())`. If a genuine
  parameterless display need surfaces later, re-adding an export is additive —
  but it would reintroduce a module-state mirror.
- **The `"inclusion"` resolution mode** (the union member, its
  `setDefaultResolutionMode` acceptance, and the resolver mode floor).
  `"allowlist"` is the focus-style substitute (a finite, branch-persisted set
  resilient to toolsets installed later). Legacy sessions carrying `{ mode:
  "inclusion" }` restore as `"exclusion"` — the entry is ignored, not migrated,
  so previously-suppressed unpinned toolsets come back at the default-on floor.
  No error is raised at restore.
- **`emitMemberEvents` and the per-member event fan-out** — the
  `ToolsetSpec.emitMemberEvents` flag and the optional `member` field on
  `ToolsetChangedEvent`. A toggle now emits exactly one event per toolset,
  always; consumers needing per-tool granularity can diff members via
  `getRegisteredToolsets()`.
- **`ToolsetSpec.description`** — presenters fall back to `label`/`id` as they
  already did when the field was absent.
- **Top-level test-only internals** — `setSettingsOverrideForTests`,
  `setSettingsWriterOverrideForTests`, and `parseToolsetDefaults` are no longer
  top-level exports; test helpers (`planBatch`, `executeBatchPlan`,
  `parseToolsetDefaults`) live under the single `__internal` export and may
  change or vanish between any releases.

## [1.3.0] - 2026-09-02

### Added

- **`piToolMasking.childPolicy` settings key** (`"defer" | "settings"`,
  top-level key, read global → project with project winning per scope —
  scalar, no spread-merge). Controls how pi-tool-masking behaves in
  subagent child sessions. At the top of every restore the process manages
  a static pid-tagged env var, `PI_TOOLMASKING_DEFER` (value = publisher
  pid, no per-toolset payload): a defer-policy parent publishes it when
  absent; a child inheriting a foreign-pid var defers — it skips the entire
  restore (branch entries, settings pins, mode resolution) and the per-turn
  `before_agent_start` re-assert, emitting no mask events, and leaves the
  var untouched (env inheritance delivers it to grandchildren; republishing
  the child's own pid would flip it to enforcing at its next same-process
  restore). A `"settings"` policy deletes the var and masks normally —
  subtree-effective, so the opt-out stops propagation to grandchildren
  (a default-defer grandchild publishes its own var). Malformed settings
  JSON is treated as absent; an invalid value (e.g. `"banana"`) warns once
  per process and is treated as absent; the reader never throws.

### Changed

- **Defer-by-default in subagent children.** With the key absent, spawned
  `pi` children no longer enforce `toolsetDefaults` pins or replay their own
  chat-branch entries — the spawner owns the child's tools (subagent plugins
  configure child tool sets explicitly via per-agent frontmatter, and
  global settings pins were silently stripping those tools). The library's
  "defaults apply" promise is parent-scoped: `toolsetDefaults` govern the
  sessions where masking runs, not children whose spawner explicitly
  configured their tools. Set `"piToolMasking": { "childPolicy":
  "settings" }` to restore enforcement in children. README documents the
  semantics and prominent caveats (descendant leakage including
  bash-spawned `pi`, masking is context hygiene not a security boundary,
  pid recycling fails safe, env-scrubbing spawners drop the channel).

## [1.2.3] - 2026-08-04

### Added

- `before_agent_start` now re-asserts the DISABLED set in exclusion and
  inclusion modes (not just allowlist), closing the same mid-session
  authority gap 1.2.1 closed for allowlist mode: force-re-added tools of a
  toolset whose effective state is off are removed again at each turn
  boundary, so a disabled toolset can no longer leak back into the turn via
  another extension's `pi.setActiveTools` reconciler. Effective state
  resolves through the same tier chain restore uses (branch entry →
  settings pin → mode floor → packaged `defaultEnabled`), extracted into a
  shared internal `effectiveEnabled` helper so restore and the re-assert
  cannot drift. Leak-direction only — default-on is not a hard constraint,
  so legitimately removed default-on tools are not force-restored. Emits
  `changed` per affected toolset (delta-gated to no-op when nothing
  drifted). Residual: depends on extension load order, same as the
  allowlist re-assert.

## [1.2.2] - 2026-08-03

### Added

- `lastCustomEntry<T>(branch, customType)` — returns the last
  `type === "custom"` branch entry matching `customType`, discriminator-
  narrowed so callers get typed `.data` without `as any`. Tombstones
  (`data: null`) are returned, not skipped.

### Changed

- Mode restore, per-toolset restore, and `clearToolsetEntry` now route
  through `lastCustomEntry` instead of casting `getBranch()` entries to
  `any`. Behavior-preserving type-safety cleanup at a hand-editable
  boundary (branch files on disk).

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
  before any per-toolset `restored` event fires (the write is skipped
  entirely when the set already matches), so a companion mirroring
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
