# Plan: Ephemeral Toolset Pass-Through to Subagent Children (env mirror)

**Status:** reviewed — ready to implement
**Goal:** a fresh child session spawned by *any* subagent plugin inherits the
parent's live toolset state (the ephemeral per-query tool selection), with no
settings changes, no child-detection heuristics, and no coupling to any one
plugin's env contract.

## Problem

Fresh child sessions re-resolve toolset state from `toolsetDefaults` in
settings.json (see `subagent-web-tool-masking-bug.md`, Layer 2). The parent's
interactive toggles (`/web on`) are chat-branch entries in the parent session
and do not cross the process boundary. Result: children deterministically land
on settings defaults, silently dropping tools the operator enabled for this
query.

The state *should* be ephemeral: it describes "what the operator wanted for
this query", not a machine-level default.

## Design

### Inversion

Do not detect "am I a subagent child" (that couples us to one plugin's
contract). Instead, mirror live state into the one channel every spawn path
already shares: **the process environment**. `child_process.spawn` inherits
the parent env by default, so any plugin that spawns real child `pi` processes
passes the mirror through with zero effort on its side.

### Publisher (parent side)

Keep `process.env.PI_TOOLMASKING_LIVE_STATE` as a standing mirror:

- **Value:** versioned, identity-tagged JSON:
  `JSON.stringify({ v: 1, pid: process.pid, boot: <random id per process>, state })`
  where `state` is `Record<persistKey, { enabled: boolean }>` for all
  registered toolsets (`boot` guards against pid reuse across unrelated
  processes; `v` guards the wire format against future evolution — old
  children ignore unknown versions gracefully).
- **When:** re-snapshot on every `tool_call` event (fires before *any* tool
  of *any* plugin executes — including whatever tool the plugin uses to
  spawn), and on parent `session_start` / `session_tree` (same
  `publishLiveState()` call — lifecycle publishes are rare and must capture
  the post-restore state). The lifecycle publishes close the
  spawn-before-first-dispatch window: a spawn from a slash-command handler or
  directly off a tree navigation happens before any `tool_call`, and would
  otherwise inherit nothing. No `_emitToolsetEvents` republication —
  `tool_call` plus the two lifecycle events are the sole publish triggers.
  **Ordering within a `session_start` dispatch is load-bearing:** the
  lifecycle publish runs **last** — after the consumer's read-and-delete
  and the restore/allowlist path (see Consumer → Read-and-delete). Both
  handlers fire in the child's process too; a publish placed before the
  consume would overwrite the var with the child's own pid/boot and the
  child's identity guard would then eat the mirror — the original bug,
  resurrected in the child. A bottom-placed publish also snapshots
  *post-restore* `getActiveTools()`, so a grandchild spawned before the
  child's first `tool_call` inherits restored state, not pre-restore state.
- **How:** toolset is "on" iff every **registered** member is present in
  `pi.getActiveTools()`. Filter `spec.names` through `pi.getAllTools()` first —
  the exact filter `_applyEnable` uses (index.ts:580-585) — then require all of
  those. Hoist `pi.getAllTools()` **once per snapshot** and filter every
  toolset against that single result (the same hoisting `reassertAllowlist`
  does at index.ts:398) — the snapshot runs on the `tool_call` hot path and
  must not rescan the tool registry per toolset. A member whose owning extension isn't loaded can never appear in
  `getActiveTools()`, so an unfiltered predicate would publish `off` forever
  for a toolset with a dead member name; with the filter, the mirror's "on"
  condition matches the enable path's definition. **Skip** any toolset whose
  `spec.names` filter to zero registered tools — `every()` on an empty set is
  vacuously true, and publishing a phantom `on` would make the child inherit-on
  a toolset whose real state is settings-resolved. No new state, no knowledge
  of subagent plugins.
- **Divergence from `isEnabled` (document):** the public `Toolset.isEnabled()`
  (index.ts:729-731) uses `.some()` — on if *any* member is active. The mirror
  uses all-registered-members. They can disagree when a foreign reconciler
  force-removed some members: `isEnabled` still says "on", the mirror says
  "off". The mirror's reading is the right one for inheritance (it reflects the
  fully-restored mask, and the child re-asserts the full mask anyway); note the
  difference in the README rather than aligning the two.
- **No dirty flag (deliberate):** publish-always on `tool_call`, with the
  delta-gate as the sole gate. A dirty flag would save only a
  `getAllTools()`/`getActiveTools()` scan + stringify on clean dispatches
  (microseconds) while adding a correctness invariant the plan must keep
  re-arguing — and its argument has a hole: late `defineToolset`
  registration changes the snapshot content without flowing through any
  flag-setting path, so a lazily-registered toolset's key could stay absent
  from the mirror indefinitely under a dirty gate. With publish-always, a
  deleted self-mirror (identity guard) also never matches the next snapshot,
  so the rewrite after `/new` happens naturally with no flag plumbing.
- **Empty envelope:** if the snapshot has zero registered toolsets (map `{}`), publish nothing — do not write a standing var that describes no state. The delta-gate against the live env value still applies (an empty snapshot simply never matches a non-empty var, so a stale one gets overwritten only when real state returns; a leftover empty-state var from a previous version is harmless and consumed as `off` for unknown keys, which are inert).
- **Delta-gate (the only publish gate):** compare the freshly serialized
  string against the **current `process.env.PI_TOOLMASKING_LIVE_STATE`
  value** and skip the write only when identical. Never compare against a
  held last-published string: the consumer runs in the parent too and its
  identity guard deletes the standing mirror on parent
  `session_tree`/`/new`/`/resume`; a held-string gate would then skip the
  rewrite and every child spawned after a tree navigation would inherit
  nothing. Against the live env value, a deleted var never matches and gets
  rewritten. Because the comparison is against the live value, it also
  catches state changes that no flag-based gate could enumerate (late
  `defineToolset` registration, identity-guard deletion) for free.
- **Observed-state ceiling (document):** the mirror reflects *observed live
  state*, not resolved intent. It diverges from `effectiveEnabled` when another
  extension's reconciler force-removed members (the documented residual leak;
  the inverse window exists too — a reconciler force-adding the one member
  of a single-member toolset publishes `on` until the next
  `before_agent_start` corrects it, even though effective state is off),
  and for a late-registered toolset (lazy `defineToolset`, post-`session_start`
  registration) whose members aren't in `getActiveTools()` yet. Both
  self-correct on the next clean `tool_call`. Keep the computation I/O-free
  (no settings read per `tool_call`). Entries are filtered to registered names
  only (parity with `_applyRestoreToolset`).
- **Registration (single handler):** install the `tool_call` listener inside
  the WeakSet-guarded `ensureRestoreHandler`, not per `defineToolset` — the
  suite asserts `handlerCount === 1` for the re-assert; the same invariant
  applies here.

Because every dispatch re-snapshots, the mirror is self-correcting: toggle web
on, spawn the lane, toggle off — the child saw "on" at its spawn instant.
Nothing is persisted to disk.

### Consumer (child side)

In `effectiveEnabled()`, insert one tier above settings defaults, active only
when the env var is present:

```
branch entry → env mirror (consume + delete) → settings defaults → mode floor → packaged
```

- **Read-and-delete:** consume at `session_start` / `session_tree` restore
  (single consumption point), then delete the var from `process.env`. The
  consume step runs at the **top** of `doRestore`, **before the allowlist
  short-circuit** — the allowlist branch opens at index.ts:307 and `return`s
  ~line 378, before the exclusion path, so a consume placed after mode resolution means
  allowlist-mode children never consume. (Publisher → When specifies the
  matching bottom placement of the publish in the same dispatch.) This is what makes the design
  correct *without child detection*: a child consumes exactly once, then
  resolves normally afterward; a fresh parent session never sees a mirror at
  all; grandchildren work — any child that spawns its own children
  re-publishes from its own live state at dispatch (the publisher side runs
  in children too, since the same extension loads there).
- **Consumer opt-out:** a one-line check for `PI_TOOLMASKING_NO_INHERIT` before
  consuming skips the mirror tier entirely — a kill switch for the ambient env
  contract, and a diagnostic for bisecting "is the mirror tier causing this?".
  The var is still deleted on this exit (see Consume hardening) — opt-out must
  not become a leak into the opt-out child's own spawns. The opt-out var
  itself is **never deleted and propagates to grandchildren**: that is its
  point — an operator (or a CI harness) setting it once disables inheritance
  for the whole subtree. Document this; do not "fix" it by scrubbing.
- **Emit type (mirror tier = explicit state):** the mirror tier returns
  `persistedEntry: true`, exactly like the branch tier. `effectiveEnabled`'s
  flag drives the restore emit (index.ts:637-639), and the mirror is the
  operator's resolved spawn-time intent — semantically a branch entry, not a
  fallback. Emitting `changed` for inherited toolsets at child `session_start`
  would break listeners that expect `restored` on restore (the documented
  contract in the `getActiveAllowlist` JSDoc). Fork children are unaffected
  (they replay real branch entries); this only governs fresh children.
- **Consumed-tier lifecycle:** the held map survives a later `session_tree`
  in the child (tree navigation must not silently drop inheritance — the env
  var is already deleted, so there is no re-read). It is **cleared** on any
  same-process `session_start` whose `reason` denotes a session switch:
  `event.type === "session_start" && reason !== "startup" && reason !== "reload"`.
  The `event.type` discriminant is load-bearing: `doRestore` handles both
  `session_start` and `session_tree`, and `SessionTreeEvent` carries **no
  `reason` field** (pi-core types.d.ts:505-510 — only `SessionStartEvent`
  has one, :416-422), so gating on `reason` alone evaluates
  `undefined !== "startup" && undefined !== "reload"` → true on every tree
  navigation and clears the map the lifecycle rule above is trying to
  protect. The mirror means
  "parent's intent at spawn instant"; a same-process session switch means
  fresh resolution. `"reload"` is the verified exception — `/reload`
  re-fires `session_start { reason: "reload" }` same-process
  (agent-session.js:2230) as the *same session re-resolved*, not a switch;
  dropping the map there would revert a reloaded child to settings defaults
  (the original bug) and contradict why `boot` and the consumed map live on
  `globalThis` in the first place. Unknown future reasons fail safe by
  clearing: spuriously dropping inheritance is recoverable and mild
  (settings resolve); keeping a stale map across a genuine switch silently
  shadows real settings, the worse direction. `/resume` fires
  `session_start { reason: "resume" }` (agent-session-runtime.js:141), so a
  reason-list of `"new"` only would leave a stale consumed map overriding
  the *resumed* session's settings and branch entries. Clearing on
  `"fork"` is harmless: forked children replay the parent's branch entries,
  which outrank the mirror tier. The pid/boot guard handles a self-mirror
  still in env; this rule handles a map already consumed into module state.
  (`doRestore` receives the event as `unknown` — narrow it to read the
  `type` and `reason` fields; the clear predicate is
  `type === "session_start" && reason !== "startup" && reason !== "reload"`.)
- **Identity guard (the `/new` case):** on consumption, compare the mirror's
  `pid`/`boot` against our own process. If it matches → this is a *stale
  self-mirror* left in our own process env (see `/new` below) → delete and
  ignore; with publish-always + delta-gate, the deleted var never matches the
  next snapshot, so the parent rewrites after `/new` with no extra plumbing.
  If it differs → genuine inheritance → consume.
- **`boot` lives on `globalThis` (MUST):** module state and the registry are
  already on `globalThis` because `/reload` re-evals the module in the same
  process. A module-local `boot` id would regenerate on re-eval while the
  standing self-mirror keeps the old one (and the same pid) — the guard would
  then misclassify our own stale mirror as foreign and consume it as a
  settings-tier override, shadowing real settings until restart. Store `boot`
  on `globalThis` next to the registry key.
- **Consumed map lives on `globalThis` (MUST):** the consumed mirror must
  *not* be held in per-restore (local) state. `reassertDisabled` — the
  `before_agent_start` re-assert — calls the same
  `effectiveEnabled(spec, branch, settingsDefaults, mode)` as restore, with
  the invariant that re-assert can never drift from restore. If the mirror
  tier is only visible to restore, the child's first turn re-asserts from
  settings defaults and strips the inherited mask back off (the exact bug,
  reintroduced one turn later). Hold the consumed map in `ModuleState` on
  `globalThis` (same pattern as `activeAllowlist`) and pass it as an extra
  tier into **both** call sites.
- **Consume hardening (single fail-closed policy):** validate the envelope
  structure on read (`v === 1`, `pid` and `boot` present, `state` a plain
  object) and cap the raw JSON size at **64KB**. Any violation — bad shape,
  unknown version, size overflow — fails closed: log one line, delete the
  var, resolve from settings. There is no per-entry repair path: a malformed
  or oversized publisher is not trusted partially (a size trip means a
  malformed or hostile publisher, not a partially-bad map), and malformed
  individual entries are made inert at resolution instead — see
  `effectiveEnabled` below, which applies the same
  `typeof enabled === "boolean"` guard the settings tier uses (index.ts:213).
  Do **not** intersect the map with the registry at consume time: the registry
  snapshot at `session_start` is an arbitrary instant — toolsets can register
  later in the child's process (late plugin load, lazy `defineToolset`,
  `/reload` re-registration into the surviving `globalThis` registry), and
  dropping their keys then would silently re-create the settings-default bug
  for those toolsets. Consume stores the whole map after envelope validation;
  "registered keys only" happens implicitly at resolution time, because only
  registered toolsets ever call `effectiveEnabled` with their own `persistKey`
  — unknown keys in the map are inert (never consulted). The var is deleted on
  **every** consumption-path exit — success, `PI_TOOLMASKING_NO_INHERIT`
  opt-out, and fail-closed — so no exit leaks the mirror into the child's own
  spawns.
- **Logging (the channel must be auditable):** the motivating bug was painful
  precisely because degradation was silent. Log one line at consumption
  ("inherited toolset state from pid X: web=on, …") and one line on
  corrupt/oversized-var fail-closed. This also makes the env-scrubbed case
  (child never sees the var) diagnosable after the fact.
- **Old masking versions in a child** ignore the unknown var entirely —
  graceful degradation.

### Zero-code alternative (note for docs)

If the spawning plugin can use `context: "fork"`, branch-entry replay already
outranks everything and the mirror is unnecessary for that path. The env
channel exists for the default `fresh` case and plugins that can't fork.

## Edge cases

| Case | Behavior | Why |
|---|---|---|
| `/new` in parent | Fresh resolution from settings; stale mirror ignored | `/new` stays in the same process (extensions.md:432 — `session_shutdown` → rebind → `session_start { reason: "new" }`). The leftover mirror carries our own pid → identity guard deletes it. This matches `/new` semantics: interactive toggles are branch entries in the *old* session and are intentionally lost. |
| `/resume` other session | Held map cleared, fresh resolution | Same-process switch; mirror is self-stale, and `session_start { reason: "resume" }` (agent-session-runtime.js:141) clears the held consumed map — a stale inherited mask must not override the resumed session's own settings. Branch entries of the resumed session replay normally via restore. |
| `/reload` in child | Inheritance **kept** | Verified: `/reload` re-fires `session_start { reason: "reload" }` same-process (agent-session.js:2230). It is the same session re-resolved, not a switch — the held map survives, so re-registered toolsets re-resolve through the mirror tier (consistent with `boot`/consumed-map living on `globalThis` to survive `/reload`). |
| Fork children (`context: "fork"`) | Unchanged | `session_start { reason: "fork" }` replays the parent's branch entries; branch tier outranks the env tier. Same-process forks (own pid) hit the identity guard, which deletes the self-stale mirror; any other fork consumes-and-deletes. The var is gone either way. |
| Spawn before the parent's first `tool_call` (e.g. a spawn directly from `session_start` or a slash-command handler that doesn't dispatch a tool first) | Child inherits the parent's state as of the parent's last `session_start`/`session_tree` publish | The lifecycle publishes (see Publisher → When) close this window for slash-command and tree-navigation spawns; only a spawn before the parent's own `session_start` handler runs sees nothing — at which point there is no resolved state to mirror anyway. |
| Nested children (grandchildren) | Correct | Consumer deletes the var after reading; the child re-publishes from its own live state when *it* dispatches. |
| Multiple toolsets / partial masks | Full map mirrored | Mirror carries every registered toolset's enabled state, so a child's mask matches the parent's mask, not just the enabled ones. |
| Plugin scrubs child env (`env: {}`) | Falls through to settings defaults | No extension-side channel exists in that case — genuine pi-core gap. Document as a known limitation; the upstream ask shrinks to "spawn hook / standard inherit-env contract" rather than a toolset dispatch param. |
| External-CLI runners (codex-exec etc.) | Out of scope | Different runtime; the masking extension isn't loaded there. |
| Concurrent spawns with different parent states | Last-snapshot-wins | The mirror is overwritten at each `tool_call`; a child spawned from a stale mirror would be impossible only if spawns raced between toggles — accepted, and strictly better than today's always-settings behavior. |
| Corrupt / oversized / wrong-version mirror value | Fail closed: delete the var, one log line, resolve from settings | Single uniform policy — a malformed publisher isn't trusted partially. Malformed individual entries (non-boolean `enabled`) are separately inert at resolution via the `typeof enabled === "boolean"` guard shared with the settings tier. |
| Parent's standing mirror in processes the parent spawns via bash | Any nested `pi` process with a current masking version consumes it as genuine inheritance (foreign pid) | Bounded by mandatory cleanup: the mirror is **deleted on parent `session_shutdown`** (same handler family as the restore listener; ~5 lines). Within a live session the var exists by design — it is the transport. |
| Child never consumes the mirror (old masking version, or no toolsets registered at `session_start`) | Var persists in the child's env and leaks into any process the child spawns (bash tools included) | An unrelated later pi process with a current masking version would treat it as genuine foreign inheritance (pid differs). Window is narrow and the state is still the original operator's spawn-time intent, so fail-open is tolerable — documented, not fixed. |
| Registry emptied mid-session while the var is live (e.g. `/reload` re-eval before re-registration) | Stale **non-empty** var persists until `session_shutdown` | The empty-snapshot rule publishes nothing, so it does not clear an existing non-empty var. A nested `pi` process spawned in that window consumes stale-but-real keys as foreign inheritance. Narrow window, booleans only — accepted; the `session_shutdown` cleanup bounds it. |
| Top-level parent whose shell carries a stale foreign-pid var (e.g. exported in a shell profile during debugging) | Consumed as genuine inheritance at the first `session_start { reason: "startup" }` | `"startup"` cannot distinguish a top-level parent from a spawned child (see probe 2). Same severity class as the nested-process leak: a wrong toolset on/off for one session, booleans only. Document alongside the bash-pollution note; no cheap code fix — deleting on sight would need child detection.

## Security / trust

The mirror carries only `{ persistKey: { enabled } }` booleans — no tool
names, no capabilities, no secrets. A malicious child could spoof a mirror in
its own env, but a child that controls its own env already controls its own
extensions; this adds no new trust boundary. Tools not owned by any registered
toolset are unaffected — the mirror only moves the masking lib's own
resolution.

## Changes (estimate ~140-180 lines + tests)

1. `index.ts` — serialize/deserialize helpers for the tagged mirror
   (`publishLiveState()`, `consumeLiveMirror()`), with `v: 1` envelope
   validation and a 64KB size cap; any violation fails closed (delete the
   var, one log line, resolve from settings) — there is no per-entry repair
   path. Publishing skips an empty
   map; the var is deleted on parent `session_shutdown`. The snapshot predicate reuses the
   registered-members filter from `_applyEnable` (filter `spec.names` through
   `pi.getAllTools()`, hoisted once per snapshot), skipping toolsets that
   filter to zero registered
   members. No registry filtering on consume — the map is stored whole and
   filtered implicitly at resolution time (see `effectiveEnabled` below), so
   toolsets registering after `session_start` still inherit.
2. `index.ts` — `tool_call` listener installed once inside
   `ensureRestoreHandler` (single handler, same invariant as the re-assert);
   publishes on every `tool_call`, delta-gated against the current
   `process.env` value (no dirty flag — see Publisher → No dirty flag);
   the same
   `publishLiveState()` call also fires on parent `session_start`/`session_tree`
   (closes the slash-command spawn window). The lifecycle publish runs at
   the **bottom** of the `session_start` handler — after the consume and
   the restore/allowlist path (ordering is load-bearing, see Consumer →
   Read-and-delete and Publisher → When). No republication
   from `_emitToolsetEvents`. The `boot` id is stored on `globalThis`
   (survives `/reload`).
3. `effectiveEnabled()` — new tier: if a *foreign-pid* mirror was consumed at
   restore, its map acts as the settings tier — a
   `consumedMirror[spec.persistKey]?.enabled` lookup guarded by the same
   `typeof enabled === "boolean"` check the settings tier uses
   (`index.ts:208`, `index.ts:213`) — malformed entries are inert by
   construction. The tier returns `persistedEntry: true` so restore emits
   `restored`, not `changed` (see Consumer → Emit type). No per-consume registry
   intersection: resolution is the filter, so a toolset registered after
   consumption still finds its inherited entry, and mirror keys for
   toolsets that never register are inert. The consumed map is held in
   `ModuleState` on `globalThis` and is visible to both `effectiveEnabled`
   call sites — restore *and* `reassertDisabled` (`before_agent_start`), so
   re-assert cannot strip the inherited mask.
4. Restore handler — consume + delete at the **top** of `doRestore`,
   **before the allowlist short-circuit**;
   var deleted on every consumption-path exit (success, `PI_TOOLMASKING_NO_INHERIT`
   opt-out, fail-closed); identity guard;
   consumption + fail-closed logging; held-map cleared on
   any same-process `session_start` whose `reason` denotes a session switch
   (`event.type === "session_start" && reason !== "startup" && reason !== "reload"` —
   clears `"new"`, `"resume"`, `"fork"`, and any unknown future reason; keeps
   `"reload"`, verified same-process at agent-session.js:2230; the
   `event.type` discriminant is required because `SessionTreeEvent` has no
   `reason` field — a reason-only gate clears the map on every tree
   navigation; narrow the `unknown` event shape for `type` + `reason`),
   kept on `session_tree`. A `session_shutdown` handler deletes the standing
   mirror (mandatory, not optional).
5. README — document `PI_TOOLMASKING_LIVE_STATE` as a **consumer-only**
   contract (only this library writes the var; other plugins consume at their
   peril — do not spec a two-way contract). Five items, one short section:
   1. **Envelope format** — `{ v: 1, pid, boot, state }` where `state` is
      `Record<persistKey, { enabled: boolean }>`; booleans only, by design
      (env vars are a dump vector — crash reporters, `set -x`, CI capture —
      so the envelope must never grow beyond inert booleans).
   2. **Precedence tier** — branch entry → env mirror → settings defaults →
      mode floor → packaged. A valid foreign mirror **outranks explicit
      settings pins** for that session.
   3. **`PI_TOOLMASKING_NO_INHERIT`** — consumer opt-out; promote it, not a
      footnote: it is the escape hatch for the mirror-over-pin precedence.
   4. **Limitations** — one line each: env scrubbing → silent fallback to
      defaults; external-CLI runners out of scope; all-or-nothing
      inheritance (no per-lane overrides); a mirror from a parent that
      never touched toolset X can publish X `on` (exclusion default) and
      silently override the child's settings pin `off` — the mirror carries
      observed state, not operator intent (the inverse of the motivating
      bug); a toggle made after the parent's last lifecycle publish that
      spawns from a slash-command handler (no intervening `tool_call`)
      inherits pre-toggle state — narrow, since most spawns go through the
      `subagent` tool (a `tool_call`); `context: "fork"` makes the
      mirror unnecessary on that path; the standing mirror leaks into any
      nested or top-level `pi` process with a stale foreign-pid var in env
      (`session_start { reason: "startup" }` is indistinguishable from a
      spawned child's — consumed as genuine inheritance, bounded by the
      mandatory `session_shutdown` cleanup; no cheap code fix);
      `isEnabled()` uses `.some()` while the mirror uses
      all-registered-members (deliberate divergence);
      `getEffectiveDefault()` does not see the mirror tier (live resolution
      is `effectiveEnabled`).
   5. **Retirement condition** — this mirror is removed when pi-core provides
      an official mechanism for parent-side extension state to reach a
      spawned child session (spawn/launch hook with extension-contributed
      bindings, a child-visible parent-context API, or an official
      inherit-state contract in the child spawn path). The trigger is the
      capability, not one subagent plugin's behavior — only a pi-core
      channel retires the bridge.
6. Tests (`__tests__/env-passthrough.test.ts`) — ~9 cases (several planned
   cases overlap; merged to keep the suite fast — the non-negotiables are
   re-assert-doesn't-strip-inheritance, consume-and-delete, identity guard
   incl. post-`/reload` boot, fail-closed, and allowlist-mode consume
   placement):
   - publish: parent publishes on `session_start`/`session_tree` (always)
     and on every `tool_call` (publish-always, no dirty flag); delta-gate:
     a `tool_call` whose snapshot matches the current env value writes
     nothing (env-write spy), and a toggle changes the snapshot so the next
     `tool_call` rewrites (covers the rewrite-after-`/new` case too: the
     identity-guard deletion makes the var not-match); a late
     `defineToolset` registration appears in the next `tool_call` snapshot
     without any toggle; a toolset with an
     unregistered member still publishes `on` (registered-members
     predicate), a toolset that filters to zero registered members publishes
     no key (vacuous-truth guard); empty snapshot publishes nothing
   - precedence: branch entry beats mirror (fork), mirror beats settings
     pin, partial map (one toolset on, one off) resolves both; mirror-resolved
     restore emits `TOOLSET_EVENTS.restored`, not `changed` (emit-type pin)
   - consume-and-delete: fresh child consumes mirror over settings defaults;
     mirror deleted after consumption (no leak to
     grandchild-from-parent-path); malformed entries (non-boolean `enabled`)
     inert while valid entries in the same map still apply
   - fail-closed: corrupt JSON, bad envelope shape, unknown version (`v: 2`),
     or >64KB — one test covering the uniform policy: settings resolve, the
     var is deleted, the fail-closed log line fires
   - re-assert: child's first `before_agent_start` does NOT remove inherited
     tools (consumed map visible to `reassertDisabled`)
   - identity: mirror ignored when tagged with own pid (`/new` case), still
     recognized after module re-eval (`boot` on `globalThis`)
   - lifecycle: held map survives `session_tree` in the child; cleared on
     same-process `session_start` with a switch reason (`"new"` and
     `"resume"` — the `/resume`-in-child case is the sharp one) and **kept**
     on `"reload"` (verified same-session exception); a mirror
     entry for a not-yet-registered toolset resolves once it registers later
     (resolution-time lookup); `session_tree` re-restore under allowlist-mode
     branch (held map inert, revives if mode flips back); `PI_TOOLMASKING_NO_INHERIT`
     set → mirror tier skipped, settings resolve, the var is deleted, and the
     opt-out var itself propagates to grandchildren (propagation pin)
   - handler hygiene: `session_shutdown` deletes the standing mirror; the
     `session_shutdown`, `tool_call`, and re-assert listeners install exactly
     once (`handlerCount(...) === 1` for repeated `defineToolset` calls)
   - allowlist parent + regression: fresh child of an allowlist-mode parent
     (no branch → mode `"exclusion"`) resolves the mirror through the
     exclusion tier — the case that makes the consume-before-allowlist-
     short-circuit placement load-bearing; no mirror in env → behavior
     identical to today

   Test-infra notes: `MockPI` needs a `tool_call` dispatch helper, and
   `fireLifecycleEvent` (`__tests__/mock-pi.ts:133`) must accept an event
   payload object (for `reason`). It already allocates a fresh event object
   per call (`mock-pi.ts:138`), so no change is needed for
   `RESTORE_EVENT_KEY` dedup. Tests must save/restore `process.env.PI_TOOLMASKING_LIVE_STATE`
   (and `PI_TOOLMASKING_NO_INHERIT`) and reset the `globalThis` module state
   (consumed map, `boot`) between tests, or the process-global tier pollutes
   subsequent cases — this is the most likely source of suite flakiness if
   skipped.

## Pre-implementation verification — all PASS (2026-06)

1. **Child env inheritance.** pi-subagents has exactly one pi-child spawn
   site: `src/runs/foreground/execution.ts:615` builds
   `spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(...) }`
   and passes it to `spawn()` at line 645. Full parent env is inherited; only
   5 diagnostic vars are explicitly cleared, none related to tool state.
2. **Fresh child pi exposes inherited env to extensions.** A throwaway
   extension in a fresh headless child (`pi --mode json --no-session -p`)
   read `PI_TOOLMASKING_LIVE_STATE` from `process.env` at
   `session_start { reason: "startup" }` — the exact event the masking restore
   handler listens on. Child ran as its own process (distinct pid). No env
   sanitization in pi-core found.
3. **`/new` is same-process.** `dist/core/agent-session-runtime.js:154`
   `newSession()`: no spawn, no re-exec — extensions are re-created
   in-process, so `process.env` survives into the new session. The pid/boot
   identity guard in the consumer is necessary, not just defensive.
4. **`tool_call` event exists and precedes execution.**
   `dist/core/extensions/types.d.ts:939` registers `on("tool_call", ...)`;
   the event union includes `CustomToolCallEvent` (plugin spawn tools fire it
   too) and documents "Fired before a tool executes";
   `dist/core/agent-session.js:226-238` wires it ahead of execution.
5. **`/reload` fires `session_start { reason: "reload" }` same-process.**
   `dist/core/agent-session.js:2230` — inside the in-process reload path,
   after `_resourceLoader.reload()`. No other `session_start` reasons exist
   in dist (startup/resume/new/fork at agent-session-runtime.js:141-283).
   This is why the held-map clear rule is
   `reason !== "startup" && reason !== "reload"` (see Consumer → lifecycle).
6. **`session_shutdown` exists, is registrable, and fires.** (probed
   2026-06, verified live) `dist/core/extensions/types.d.ts:479` defines
   `SessionShutdownEvent { reason: "quit" | "reload" | "new" | "resume" |
   "fork" }` and `:916` exposes `on("session_shutdown", ...)`. Emission
   sites in dist: `AgentSessionRuntime.teardownCurrent()`
   (agent-session-runtime.js:102-111) — called for `"new"` (:160),
   `"resume"` (:136, :143), and `"fork"` (:206, :224) — plus
   `dispose()` for `"quit"` (:290) and the in-process `/reload` path
   (agent-session.js:2213). Interactive quit calls `runtimeHost.dispose()`
   (interactive-mode.js:3223); headless `-p` calls `disposeRuntime()` →
   `runtimeHost.dispose()` (print-mode.js:23-29, :138), so the cleanup
   fires in headless children too. Live probe: throwaway extension in a
   fresh headless child (`pi --mode json --no-session -e ./probe.js -p)
   logged both`session_start { reason: "startup" }` and
   `session_shutdown { reason: "quit" }` same-pid. The mandatory
   `session_shutdown` mirror cleanup is real; the `/new` path fires it
   via `teardownCurrent("new")` before the new session's
   `session_start { reason: "new" }`.

7. **Pinned typings expose both new events (verified 2026-09).** The repo
   pins `@earendil-works/pi-coding-agent ^0.83.0`; its
   `dist/core/extensions/types.d.ts` exposes `on("tool_call", ...)` (:909
   area), `on("session_shutdown", ...)` (:918 area), `SessionStartEvent` with
   `reason` (:416-422), and `SessionTreeEvent` **without** `reason`
   (:505-510 — the basis for the `event.type` discriminant in Consumer →
   Consumed-tier lifecycle). Typecheck is not in CI but gates publish
   (`prepublishOnly`), so run `npm ci && npx tsc --noEmit` with scratch
   `pi.on(...)` handlers for both events as the first implementation step.

Residual gap: probes 1–2 verify the transport; the masking-resolution tier
itself is repo-local code and is covered by the unit tests above. A full
`researcher`-child probe with `web-search` executing end-to-end is the final
integration check, doable as part of implementation review.

## Upstream follow-ups (separate from this change)

- File the pi-subagents defect: allowlist entry matching nothing should warn
  at dispatch (the silent-degradation amplifier).
- Request a pi-core spawn/launch hook so extensions can contribute
  launch bindings officially (the existing `extensionBindings` channel has no
  "parent extension contributes at spawn time" path). This is the retirement
  condition for the env channel — see the README criterion above; it also
  removes the exposure if any plugin ever sanitizes unknown env vars.
