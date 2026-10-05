# Changelog

## [Unreleased]

### Added

- **`toggleBatch(pi, sessionManager, ops)`** — toggle a batch of toolsets in
  one call; the sole toggle actuation path, with `Toolset.enable`/`.disable`
  kept as one-line single-op wrappers delegating to it (so the two surfaces
  cannot diverge; no consumer migration is required). One batch is one
  coherent intent: the planner resolves explicit targets plus their cascade
  closures into a final state per id and returns a flattened intent delta —
  one `ToggleResult` per id whose final state differs from the pre-call
  resolved state or whose loadout wrote (an op already in its desired state
  is absent from the result). Gate order: defer → empty `ops` → allowlist
  refusal → plan → settings snapshot → execute (every refusal atomic;
  an empty batch returns `[]` before the mode check in every governance
  mode). Input semantics: an explicit op naming an unregistered id throws;
  implied unregistered closure deps stay leniently skipped (forward
  references tolerated); duplicate ops dedupe silently when `desired`
  matches and throw when it conflicts. See README for the full contract.
- **`CycleError`** — thrown by the planner when a cycle is reachable from
  any requested op, before any write or emit (cycle throws are now atomic —
  see Changed). Carries the discovered path as `cyclePath`. Catch by
  `err?.name === "CycleError"`, never `instanceof` (same rationale as
  `AllowlistModeError`); messages are diagnostics, never string-matched.
- **`ContradictionError`** — thrown by the planner when the resolved batch
  intent is incoherent: an id would end up enabled while a transitive
  `requires` dependency of it is disabled by the same batch (conflicting
  duplicate ops on one id are the zero-hop form; the one-hop
  explicit-vs-explicit case reduces to it). No winner is picked — a caught
  refusal means "refused, nothing changed"; coherent explicit-beats-implied
  survives (`enable Y` + `disable Z`, Z requires Y → `{Y: true, Z: false}`).
  Catch by `err?.name === "ContradictionError"`, same name-based contract.
- **`PersistKeyCollisionError`** — thrown by `defineToolset` when a different
  registered toolset already claims the spec's `persistKey` (two toolsets
  sharing one persistKey would fight over the same persisted intent entries).
  Atomic: registration writes nothing. Carries `persistKey` and the
  `existingId` that owns it. Catch by
  `err?.name === "PersistKeyCollisionError"`, never `instanceof` (same
  rationale as `AllowlistModeError`); messages are diagnostics, never
  string-matched. Previously a plain `Error` with no identifying surface
  beyond the message string.
- **`AllowlistModeError`** — thrown by every toggle under allowlist
  governance (see the Breaking entry under Changed). Carries `specId` on
  single-op refusals (through the `enable`/`disable` wrappers); absent
  (`undefined`) on batch-path refusals — the refusal is mode-global and
  attributes nothing. Catch by
  `err?.name === "AllowlistModeError"`, never `instanceof` — `Toolset`
  handles come from the shared `globalThis` registry and may belong to a
  different physical copy of the library, so cross-instance `instanceof`
  fails silently in exactly the setup the registry exists to support.
  Deliberately unlike `MalformedSettingsError`, which keeps its
  `instanceof` contract: its throwers (the settings writers) are
  same-module-instance imports, so a cross-instance comparison cannot
  arise there.
- **`isDeferredChild()`** — the env-only defer predicate
  (`PI_TOOLMASKING_DEFER` foreign-pid check, never settings) shared by the
  re-assert dispatcher and the toggle gate, exported so consumers gate
  their own actuation and governance-authoring flows with the identical
  signal. In a deferring child every library toggle is a silent no-op and
  `setDefaultResolutionMode`/`clearToolsetEntry`/`clearAllToolsetEntries`
  write nothing (validation still throws); `forceToolsetEnabled`, raw
  `appendEntry`, and the settings writers stay live.
- **`readBranchModeState(branch)`** — the governance decision read, the
  same shared branch read restore, the resolver, the re-assert dispatcher,
  and the toggle refusal use: returns `{ mode, allowlist }` (absent entry
  → exclusion, corrupt array → `[]`), copy-on-read in both directions (the
  returned array is fresh; `setDefaultResolutionMode` copies its input
  before `appendEntry` — pi stores entry `data` by reference, so neither
  the library's reads nor its writes may alias persisted governance). For
  consumer decision/authoring paths only — **never** a toggle pre-check:
  call the toggle and catch `AllowlistModeError`.
- **`effectiveEnabled(spec, branch, defaults)`** — exported resolver for a
  toolset's persisted intent: allowlist override (mode read from the passed
  `branch`) → chat-branch entry → settings pin → `defaultEnabled ?? true`,
  the same tier chain restore and the per-turn re-assert actuate on
  (`defaults` is a `readMergedToolsetDefaults()` snapshot).
  Returns `{ enabled, persistedEntry }` — display surfaces read
  `.enabled`; `persistedEntry` is true only when the last branch entry for
  the toolset carries a boolean `enabled` (a `null` tombstone or no entry
  reports `false`). The read side stays mode-dependent by design — the
  branch ledger under exclusion, `allowlist.includes(spec.id)` under
  allowlist (an accepted residual, never unified); the intended consumer
  rule: display surfaces read intent (`effectiveEnabled`),
  declaration-sensitive surfaces read observation (`isEnabled()`), and
  nothing gates a toggle with it — call the toggle and catch.
- **`enable`/`disable` return a change report: `ToggleResult[]`.** One
  `{ id, enabled }` entry per toolset whose user-visible state changed
  (intent delta or loadout write), `[]` on a silent no-op; a cascade
  aggregates into the one flat array (each changed toolset exactly
  once — enforced structurally by the planner's visited set, valid in
  every mode).
  `id` is `spec.id`; `enabled` is the value that call persisted and
  emitted — the appended branch entry, the `changed` event payload, and
  the report always carry the same value (a residue cleanup re-affirms
  the existing off entry and reports `{ enabled: false }`).

### Changed

- **`defineToolset` reserves the resolution-mode branch key.** A spec whose
  `persistKey` is `"toolset-resolution-mode"` now throws a validation
  `Error` at registration — its `{ enabled }` toggle entries would otherwise
  supersede the branch's resolution-mode entry (and vice versa) via
  last-writer-wins, silently dropping allowlist governance. No legitimate
  consumer key is affected.
- **Breaking: `toggleBatch` added as the sole toggle actuation path;
  `Toolset.enable`/`.disable` are now wrappers over it.** Behavior through
  the wrappers is unchanged (same signatures, same `ToggleResult[]`, same
  defer-child `[]` semantics, `AllowlistModeError.specId` set exactly as
  before) — the method surface is unchanged by this release, so no consumer
  break is created. The internal gate/cascade plumbing (`toggleGate`, the
  per-direction walkers) is deleted.
- **Breaking: cycle errors are atomic and named.** Previously a cycle
  detected mid-cascade could leave prior cascade writes standing (the throw
  happened during execution); now the cycle is detected in the pure
  planning phase and thrown as `CycleError` before any write or emit.
  Cycle detection no longer carries direction-specific messages — catch by
  `err?.name`, never message text.
- **Breaking: emits moved from per-apply to post-execution — this changes
  cascade emit timing for every toggle call that cascades, not just
  multi-op batches.** A `changed` listener on a dependency now fires after
  its dependents are written, so `pi.getActiveTools()` observed inside that
  listener differs from earlier releases. The payoff: no library-emitted
  event fires until every write in the call has completed, so a synchronous
  `changed` listener cannot intercept through the library's own event
  channel mid-call, and listeners observe one coherent transition. Racing
  writers on channels outside the library's events (`prepareLoadout` hooks
  reached inside `setActiveTools`) can still append mid-call; such a write
  for an id whose intent already
  matched is neither repaired nor reported and wins at the next restore by
  last-writer-wins (pinned residual, documented in README).
- **Breaking: report/emit order is now the planner's discovery order** —
  ops in op order, enable deps-first post-order over `requires` in
  declaration order, disable self-first over dependents in registry order.
  Identical to the legacy walker orders for every single-op call; multi-op
  batches may interleave discovery across targets (semantically harmless —
  the delta is per-id against pre-call state, and all writes precede all
  emits).
- **Breaking: `AllowlistModeError.specId` is optional** — set exactly as
  today through the single-op wrappers; absent (`undefined`) on batch-path
  refusals. The refusal is mode-global (every requested id was refused for
  the pinned mode), so a batch refusal attributes nothing; consumers render
  the refusal from their own op list.
- **Breaking: gate order revised — the settings snapshot moves after
  validation.** New order: defer → empty `ops` → allowlist refusal → plan
  (cycle/contradiction/input validation) → settings snapshot → execute. A
  deferring child returns `[]` before the mode check (unchanged); an empty
  `ops` array also returns `[]` before the mode check in every governance
  mode — an empty batch requests nothing, so refusing it under allowlist
  governance would be incoherent with the refusal contract. Exactly one
  branch read and one settings read per toggle call; `before` (the delta's
  basis) is derived by the executor from that same snapshot.
- **Breaking: toggles are an exclusion-mode operation — allowlist mode
  rejects them.** At the top of `toggleBatch` (after the defer and
  empty-`ops` gates, before planning and the settings snapshot) the branch
  mode is read via `readBranchModeState`; under allowlist governance every
  toggle throws `AllowlistModeError` — atomic by construction
  (no branch entry, no `changed` emit, no loadout write); a caught refusal
  means "refused, nothing changed". This removes the
  legal-but-incoherent allowlist toggle rows: the shadowed enable whose
  members went live until the next re-assert, the never-silent repeat
  rows, and the event/report disagreement are all unreachable from the
  toggle API. Convergence after a refusal is the per-turn re-assert's job
  (state converges to the allowlist, which in half the quadrants is the
  opposite of the request — correct under allowlist governance); immediate
  actuation under focus is `forceToolsetEnabled`, the documented primary
  actuation path. The per-turn re-assert's arm selection also joins the
  branch read (it previously picked its arm from a module-state mirror),
  so every governance decision in the library reads one source: in the
  disagreement windows (fresh process before its first restore; a mode
  entry appended without `setDefaultResolutionMode`) the branch read is
  the correction.
- **Breaking: in a deferring child, every public API that implicitly
  writes branch governance state is a silent no-op** (the traceability
  rule): every toggle returns `[]` before the mode check (no throw,
  no write, no emit), `setDefaultResolutionMode` is
  validate-then-suppress (invalid input still throws; only the branch
  append is suppressed), and `clearToolsetEntry`/`clearAllToolsetEntries`
  write nothing. Deliberate write/actuation APIs stay live:
  `forceToolsetEnabled`, raw `appendEntry`, and the settings writers
  (`writeToolsetDefaults`/`clearToolsetDefaults` — the settings tier is
  outside the rule). The noops are fully silent — no notify channel exists
  on `ExtensionAPI`; the silence is documented behavior. Gate order is
  part of the contract: defer → empty `ops` → allowlist refusal → plan →
  settings snapshot → execute.
- **Breaking: `enable`/`disable` now take a required `sessionManager`
  branch reader.** In practice pass `ctx.sessionManager` — the reader
  object itself, never a bare `getBranch` method reference (the
  `BranchReader` type makes that a compile error; an unbound method would
  throw). The library reads the branch once per toggle call, at that
  call's boundary, so one reader passed once per command stays correct
  across cascades and loops (each wrapper call re-reads at its own
  boundary). The toggle path's intent source is the pre-computed plan
  resolved against this branch read — no cached intent state — so
  external branch writes (another extension appending entries, or
  clobbering the active set) before the call are visible by construction;
  inside a call the plan is the authority (see the emit-timing entry
  above for the boundary). The
  old observation-based gates are deleted; the delta gate is the only
  contract, and there is no branchless fallback — a call site without
  `ctx` restructures to obtain one, and an empty branch means only "no
  intent recorded yet", never "no branch available". This fixes the
  clobbered-active drop: a user's off toggle on a toolset whose members
  were removed from the active set by another extension now persists the
  off entry and emits instead of being silently dropped. The
  `hidden`-exposure actuatable filtering survives: actuation paths still
  filter `hidden` members out of `setActiveTools` (on pi < 0.99 behaviour
  is unchanged).
- **Same-value toggles go silent; the rule pair governs:** persist + emit
  iff the intent changes **or** a loadout write occurred. A toggle whose
  resolved intent already matches the requested state and that needs no
  loadout write is a silent no-op (`[]` from the change report) —
  previously every same-value toggle on an inert or partially-registered
  toolset re-persisted and re-emitted. This is an exclusion-mode contract
  by construction: under allowlist governance the toggle throws
  `AllowlistModeError` instead (see the Breaking entry above), so the
  delta gate runs only under exclusion governance. Cascade repeats are
  silent by construction (the planner's visited set yields each id
  exactly once per call). Enable-after-clobber stays loud on
  purpose: the loadout repair fires, so the on entry and `changed` emit
  fire with it (the active set actually changed, and downstream surfaces
  should redraw).
- **Breaking: `applyToolsetEnabled` is renamed
  `forceToolsetEnabled(pi, spec, enabled)` and stays `void`.** Same
  contract — never persists, no cascade, always applies, always emits —
  but the report is dropped: it shares the restore path, whose
  always-emit invariant can never honor the `ToggleResult[]` contract
  (`[]` ⇔ silent no-op). The `force…` name marks it as the actuation
  primitive that bypasses the intent gate; report-returning
  `enable`/`disable` are the intent path.

### Removed

- **`getActiveAllowlist()` and `getDefaultResolutionMode()` — deleted,
  along with their module-state fields** (`ms.activeAllowlist`,
  `ms.defaultResolutionMode`). The re-assert dispatcher's switch to the
  branch read leaves the allowlist mirror no internal reader, and the mode
  variable was write-only except for its getter; with
  `readBranchModeState(branch)` public, both parameterless mirrors are
  strictly worse duplicates of the read restore itself resolves from, and
  the parameterless shape is exactly what let consumer guards silently
  pass on a stale read. Migrate decision reads to
  `readBranchModeState(ctx.sessionManager.getBranch())` (tbox's
  `focusRelease`/`actuateNewToolsets`, the lean repos'
  `isFocusHolding()` guards — all migrated in the same window). If a
  genuine parameterless display need surfaces later, re-adding an export
  is additive and non-breaking — but it requires reintroducing a
  module-state mirror, the exact shape this release removes.
- **The `"inclusion"` resolution mode** — the `DefaultResolutionMode` union
  member, its `setDefaultResolutionMode` acceptance, and the resolver mode
  floor. `"allowlist"` is the focus-style substitute (a finite,
  branch-persisted set resilient to toolsets installed later). Legacy
  sessions carrying `{ mode: "inclusion" }` branch entries restore as
  `"exclusion"` — the entry is ignored, not migrated, so previously-
  suppressed unpinned toolsets come back at the default-on floor (the same
  default every fresh session starts from). No error is raised at restore.
- **`emitMemberEvents` and the per-member event fan-out** — the
  `ToolsetSpec.emitMemberEvents` flag and the optional `member` field on
  `ToolsetChangedEvent`. No consumer ever set the flag (tbox's picker
  explicitly deferred it as YAGNI); a toggle now emits exactly one event
  per toolset, always. Consumers needing per-tool granularity can
  subscribe to the group event and diff members via
  `getRegisteredToolsets()`.

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
