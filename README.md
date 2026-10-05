# pi-tool-masking

A library for pi plugin developers that groups tools into toggleable **toolsets** with persistent state and cross-extension events — eliminating the boilerplate every pi extension repeats when it wants to let users disable tools cleanly.

`pi-tool-masking` is **not** a pi extension itself. It is a dependency that your extension imports. It owns the toggle logic, the session-restore path, and the event bus. Your extension owns the commands, the status bar, and the user-facing surfaces.

---

## Why use it?

Without `pi-tool-masking`, every pi extension that toggles tools reimplements the same pattern:

1. Maintain a `Set` of active tool names.
2. On enable, add members to `pi.setActiveTools()` and, when the resolved intent changes or a loadout write occurs, append a persist record via `pi.appendEntry()`.
3. On disable, filter members *out* of `pi.getActiveTools()` and, under the same rule, append a persist record.
4. On `session_start` / `session_tree`, walk the branch for persisted entries and re-apply state.
5. Emit events so side-effect owners (status bars, pickers) can re-render.

`pi-tool-masking` does all of that in one call: `defineToolset(pi, spec)`. It also adds dependency cascading (enabling a toolset auto-enables its dependencies) and reverse cascading (disabling a toolset auto-disables dependents), plus a settings tier for per-scope defaults and allowlist mode for reliable focus across reloads.

---

## Install

```bash
npm install pi-tool-masking
```

Then import from the package name in your extension:

```ts
import { defineToolset, TOOLSET_EVENTS } from "pi-tool-masking";
```

---

## Quick start

```ts
import { defineToolset, TOOLSET_EVENTS } from "pi-tool-masking";
import type { ToolsetSpec } from "pi-tool-masking";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WEB_SPEC: ToolsetSpec = {
 id: "my-plugin.web",
 names: new Set(["web-fetch", "web-snapshot"]),
 persistKey: "toolset-state:my-plugin.web",
 defaultEnabled: true,
};

export default function activate(pi: ExtensionAPI) {
 const webToolset = defineToolset(pi, WEB_SPEC);

 // React to state changes (e.g. update a status glyph)
 pi.events.on(TOOLSET_EVENTS.changed, (event) => {
  if (event.id === "my-plugin.web") {
   pi.ui.setStatus("myPlugin", event.enabled ? "on" : "off");
  }
 });

 // Register a command that toggles the toolset
 pi.registerCommand("my-plugin", {
  description: "Toggle web tools on/off",
  handler: async (args, ctx) => {
   if (args.trim() === "on") {
    webToolset.enable(pi, ctx.sessionManager);
   } else if (args.trim() === "off") {
    webToolset.disable(pi, ctx.sessionManager);
   }
  },
 });
}
```

That's it. The toolset is registered, its members are managed, and state persists across reloads, resumes, and tree navigations — no `appendEntry` or `session_start` restore code required. The toggle takes the branch reader (`ctx.sessionManager`) as its second argument: each toggle call reads the branch once at its own boundary and resolves against current intent — a toggle that repeats the already-resolved state is a silent no-op, and one that repairs a divergence (e.g. another extension clobbered the active set) persists and emits.

---

## API

### `defineToolset(pi, spec)`

Register a toolset and receive a `Toolset` handle (`enable`, `disable`, `isEnabled`).

| Parameter | Type | Required |
|---|---|---|
| `pi` | `ExtensionAPI` | Yes — the pi extension API instance |
| `spec` | `ToolsetSpec` | Yes — the toolset definition |

**Idempotent re-registration:** calling `defineToolset` with the same `spec.id` and an unchanged spec returns the existing toolset. This is safe across `/reload`.

### `toggleBatch(pi, sessionManager, ops)`

Toggle a batch of toolsets in one call — the sole toggle actuation path; the [`Toolset`](#toolset-handle) `enable`/`disable` methods are one-line single-op wrappers delegating here, so they cannot diverge from it.

```ts
toggleBatch(pi, ctx.sessionManager, [
  { id: "my-plugin.web", desired: true },
  { id: "my-plugin.learn", desired: true },
]);
```

**Gate order** (every refusal atomic — nothing written, nothing emitted):
defer → empty `ops` → allowlist refusal → plan → settings snapshot → execute. A deferring child returns `[]` before the mode check; an empty `ops` array returns `[]` before the mode check in every governance mode (an empty batch requests nothing). Under allowlist governance the whole batch is refused in one throw — a mode-global refusal carries no id (`err.specId === undefined`); consumers render the refusal from their own op list.

**Input semantics:** an explicit op naming an unregistered id throws (a deliberate claim by the caller — silently skipping it would swallow the bug class the refusal contract exists for); an implied closure dep that is unregistered stays leniently skipped (forward-referenced `requires` entries are tolerated). Duplicate ops with the same `desired` dedupe silently; conflicting `desired` on one id throws.

**One batch is one coherent intent.** The planner resolves explicit targets plus their cascade closures (an enable pulls its `requires` closure on, a disable pulls its dependents closure off; explicit targets win over implied values) into a final state per id, and returns a flattened intent delta — one `ToggleResult` per id whose final state differs from the pre-call resolved state or whose loadout wrote (an op already in its desired state is absent from the result). Conflicting intents throw `ContradictionError` — e.g. "disable all, then enable the unit" (`soloUnit`) must stay two calls, since one batch would refuse the unit's enabled intent against the explicit disable of its dependency. No library-emitted event fires until every write has completed; emits fire once, in the planner's discovery order — deps come on before their dependents, and a disabled root reports before what fell with it.

**Throws**, all caught by `err?.name === ...`, never `instanceof` (throwers may belong to a different physical copy of the library); messages are diagnostics and never string-matched:

| Error | When |
|---|---|
| `AllowlistModeError` | Allowlist governance (mode-global, no `specId` on this path) |
| `CycleError` | Any cycle reachable from any op — thrown before any write (carries the cycle path as `err.cyclePath`) |
| `ContradictionError` | The resolved intent is incoherent — an id enabled while a transitive `requires` dependency of it is disabled by the same batch; conflicting duplicate ops on one id are the zero-hop form |
| plain `Error` | An explicit op naming an unregistered id |

### `setDefaultResolutionMode(pi, mode, allowlist?)`

Switch how toolsets with no persisted state resolve on restore. Two modes:

| Mode | Behavior on restore (no persisted entry) |
|---|---|
| `"exclusion"` (default) | Toolsets default **on** if `defaultEnabled` is true, **off** otherwise |
| `"allowlist"` | Only the listed toolset ids are **on**, everything else **off** — a finite, branch-persisted set whose complement is computed at restore, resilient to toolsets installed later. Pass the array as the third argument: `setDefaultResolutionMode(pi, "allowlist", ["my-plugin.web"])`. **This mode has no toggle path:** toggles are an exclusion-mode operation — every toggle (`Toolset.enable`/`.disable`, `toggleBatch`) throws `AllowlistModeError` under allowlist governance (atomic, nothing changed); actuation goes through `forceToolsetEnabled`, and exit via `setDefaultResolutionMode(pi, "exclusion")` |

### `readBranchModeState(branch)`

Read the governance decision from a branch — the same shared read restore, the resolver, the re-assert dispatcher, and the toggle boundary use. Returns `{ mode, allowlist }`: `"allowlist"` with the listed ids, or `"exclusion"` (with `allowlist: []`) when no mode entry exists or the value is unrecognized; a corrupt allowlist fails closed (non-array → `[]`, non-string members dropped).

For **decision and authoring paths only** — consumer flows that never route through a toggle (a focus-release flush, pre-call UI shaping such as greying out a menu item) — **never a toggle pre-check**: call the toggle and catch `AllowlistModeError`; the throw is the toggle authority. Copy-on-read: the returned array is a fresh copy, never a reference into the branch (pi stores entry `data` by reference, so a reference-returning read would alias persisted governance).

### `isDeferredChild()`

`true` when this process is a governance-deferring child — a defer-publisher ancestor suspended masking for its subtree (see [Subagent inheritance](#subagent-inheritance-child-policy-defer)). Env-only: reads the `PI_TOOLMASKING_DEFER` pid tag, never settings, so a mid-session policy flip cannot flip a child that restored under defer. Exported so consumers gate their own actuation and governance-authoring flows with the identical signal the library's dispatcher and toggle gate use. In a deferring child every library toggle is a silent no-op (`[]`), and `setDefaultResolutionMode` / `clearToolsetEntry` / `clearAllToolsetEntries` write nothing (validation still throws); the deliberate write/actuation APIs — `forceToolsetEnabled`, raw `appendEntry`, the settings writers — stay live.

### `getRegisteredToolsets()`

Return every registered toolset (`{ spec, toolset }`). The returned **array is a copy** (mutating the array cannot corrupt the registry), but each element is the **live registry entry** — mutating `entry.spec.names` (with a fresh `Set`) reaches the registry in place. That is the mechanism for [runtime membership changes](#runtime-membership-changes); see that section for the contract and its caveats. No `pi` argument needed — pure registry read.

### `effectiveEnabled(spec, branch, defaults)`

Resolve a toolset's current **persisted intent** — the tier chain restore resolves, as a pure function:

```ts
effectiveEnabled(spec, branch, readMergedToolsetDefaults())
```

| Parameter | Type | Notes |
|---|---|---|
| `spec` | `ToolsetSpec` | The toolset to resolve |
| `branch` | Branch snapshot | `ctx.sessionManager.getBranch()` inside a handler |
| `defaults` | `Record<persistKey, { enabled }>` | Required — pass a `readMergedToolsetDefaults()` snapshot (read once per loop to avoid re-reading disk per toolset) |

Returns `{ enabled, persistedEntry }` — read `.enabled` for display (intent rendering); `persistedEntry` is true only when the last branch entry for this toolset carries a boolean `enabled` (a `null` tombstone or no entry reports `false`). Resolution order:

1. **Allowlist mode** (read from the passed `branch`): returns `{ enabled: allow.includes(spec.id) }` — the set-level override is authoritative, branch entries and settings pins are bypassed, exactly as restore's allowlist short-circuit does.
2. **Chat-branch entry** — the last `appendEntry(persistKey, …)` on this branch (`null` tombstone falls through).
3. **Settings pin** — `toolsetDefaults[persistKey].enabled`.
4. **Packaged default** — `spec.defaultEnabled ?? true`.

This is what display surfaces should read (see [Intent vs observation](#intent-vs-observation)); **never a toggle pre-check** — call the toggle and catch. `getEffectiveDefault` differs: it resolves settings → packaged only, ignoring the branch and mode. There is no `mode` parameter — allowlist detection comes from the branch itself.

### `TOOLSET_EVENTS`

| Event | When |
|---|---|
| `changed` | A toolset was toggled by a consumer |
| `restored` | A toolset's state was restored from persisted session state |

### Types

| Type | Description |
|---|---|
| `ToolsetSpec` | Schema for defining a toolset (see below) |
| `Toolset` | Handle returned by `defineToolset` |
| `ToolsetChangedEvent` | Shape of events emitted by `TOOLSET_EVENTS` |
| `ToggleResult` | `{ id, enabled }` — one entry of a toggle's change report (`id` = `spec.id`; `enabled` = the value that call persisted and emitted). One entry per id whose resolved intent changed **or** whose loadout wrote — inert toolsets still report on intent delta |
| `BranchReader` | Anything with a synchronous `getBranch()` — pi's `ReadonlySessionManager` satisfies it; pass `ctx.sessionManager` itself |
| `RegistryEntry` | `{ spec: ToolsetSpec; toolset: Toolset }` — a single registered toolset |
| `DefaultResolutionMode` | `"exclusion" \| "allowlist"` |
| `MalformedSettingsError` | Thrown by `writeToolsetDefaults` / `clearToolsetDefaults` when settings.json is corrupt or non-object (never silently overwritten). Catch with `instanceof` — safe because those writers are imported from the same module instance as the catcher. |
| `AllowlistModeError` | Thrown by every toggle under allowlist governance (`enable`/`disable` and `toggleBatch`). Catch by `err?.name === "AllowlistModeError"`, **never** `instanceof` — handles come from the shared `globalThis` registry and may belong to a different physical copy of the library, so cross-instance `instanceof` fails silently. `specId` is set on single-op refusals (through the `enable`/`disable` wrappers), absent (`undefined`) on batch refusals — the refusal is mode-global and attributes nothing. |
| `CycleError` | Thrown by the planner when a cycle is reachable from any requested op, **before any write or emit**. Catch by `err?.name === "CycleError"`, same name-based contract as `AllowlistModeError`; messages are diagnostics, never string-matched. Carries the cycle path as `cyclePath`. |
| `ContradictionError` | Thrown by the planner when the resolved batch intent is incoherent (see [`toggleBatch`](#togglebatchpi-sessionmanager-ops)). Catch by `err?.name === "ContradictionError"`, same name-based contract; messages are diagnostics, never string-matched. |
| `PersistKeyCollisionError` | Thrown by `defineToolset` when a different registered toolset already claims the spec's `persistKey` (atomic — registration writes nothing). Catch by `err?.name === "PersistKeyCollisionError"`, same name-based contract; messages are diagnostics, never string-matched. Carries `persistKey` and the `existingId` that owns it. |
| `BatchOp` | `{ id, desired }` — one requested toggle in a [`toggleBatch`](#togglebatchpi-sessionmanager-ops) call |

---

## Toolset defaults (settings tier)

A toolset's fresh-session default is no longer locked to its packaged `spec.defaultEnabled`. Users can pin `{ enabled: boolean }` under a reserved `toolsetDefaults` key in pi-core settings, keyed by the toolset's full `persistKey` — without toggling (which writes a session-scoped chat-branch entry). The library reads both files itself inside `doRestore`, fresh on each `/reload`, so downstream consumers no longer need to reinvent a settings reader to inject values into `spec.defaultEnabled` before `defineToolset`.

Restore resolves each toolset's default in this order (first hit wins):

1. **Chat-branch entry** — the last `appendEntry(persistKey, …)` on this branch. A `null` tombstone (see [`clearToolsetEntry`](#tombstone-helpers)) falls through to the tiers below.
2. **Settings pin** — `toolsetDefaults[persistKey].enabled`, merged global → project (project wins per entry). Mode-agnostic.
3. **Packaged default** — `spec.defaultEnabled ?? true`, filtered by resolution mode for unpinned toolsets only.

Settings pins are honored in exclusion mode, mirroring how chat-branch entries are honored — only unpinned toolsets consult mode for the floor. While allowlist mode is active, pins and branch entries are bypassed: the active set is exactly the allowlist members.

### `readMergedToolsetDefaults()`

Read and merge `toolsetDefaults` from global (`~/.pi/agent/settings.json`, or `$PI_CODING_AGENT_DIR/settings.json`) and project (`<cwd>/.pi/settings.json`) settings. Project overrides global per entry. Missing/unreadable/malformed files contribute `{}`. Never throws. Returns `Record<persistKey, { enabled: boolean }>`. Read once per loop and pass the snapshot to `getEffectiveDefault` to avoid re-reading disk per toolset.

### `readToolsetDefaults(scope)`

Read one scope's raw `toolsetDefaults` block (no merge). `scope` is `"global"` or `"project"`. Same never-throw policy. Use for `defaults show`-style commands that need per-scope attribution.

### `writeToolsetDefaults(entries, scope)`

Merge a batch of `{ [persistKey]: { enabled } }` entries into one scope's `toolsetDefaults`, preserving every other top-level key and every existing entry not in `entries`. A write where every entry already matches its on-disk value is a no-op (no reformat, no mtime bump). Returns the settings file path. **Throws `MalformedSettingsError`** if the file exists but parses to a non-object or is unparsable — a corrupt file is never silently overwritten.

### `clearToolsetDefaults(scope)`

Remove the `toolsetDefaults` wrapper key entirely from one scope, preserving every other top-level key. Returns the path removed from, or `null` if the key was already absent (or the file missing). No per-entry clear by design — write an `entries` map without the unwanted keys via `writeToolsetDefaults`. Same `MalformedSettingsError` guard.

### `getEffectiveDefault(spec, snapshot?)`

Resolve a toolset's effective fresh-session default: settings tier (2) then packaged `spec.defaultEnabled ?? true` (3). **Ignores resolution mode** — callers needing mode-aware behavior must consult `readBranchModeState(ctx.sessionManager.getBranch())` themselves. Pass an explicit `snapshot` (from `readMergedToolsetDefaults()`) when looping over multiple toolsets; omit it for a one-off (it performs its own read).

## Subagent inheritance (child policy defer)

Fresh child sessions spawned by subagent plugins re-resolve toolset state from settings — the parent's interactive toggles are chat-branch entries and don't cross the process boundary, and settings defaults are global. A child whose spawner explicitly configured its tool set (pi-subagents `tools:` frontmatter, per-agent config) would silently lose settings-pinned-off toolsets: the mask beats the spawner's explicit tool request.

This library's default is to **defer to the spawner**: the parent publishes a static pid tag into the process environment (the one channel every spawn path already shares), and any `pi` child that inherits it skips masking entirely for its session.

### The `piToolMasking.childPolicy` setting

Top-level key in pi-core settings (global `~/.pi/agent/settings.json` or project `.pi/settings.json`; project wins). Read once per restore, never on the per-turn path. Malformed settings JSON is treated as absent; an invalid value (e.g. `"banana"`) warns once per process and is treated as absent. The reader never throws.

```json
{ "piToolMasking": { "childPolicy": "defer" } }
```

| Value | Behavior at each restore |
|---|---|
| `"defer"` (default) | If `PI_TOOLMASKING_DEFER` is absent, publish it (value = own pid — a top-level parent). If it carries a **foreign** pid, defer: the entire restore is skipped (branch entries, settings pins, mode resolution — both tiers) and the per-turn `before_agent_start` re-assert is a no-op. The var is left **untouched** — env inheritance already delivers the parent's pid to grandchildren, and republishing the child's own pid would flip it to enforcing at its next restore (`/new`, `/resume`, `session_tree`). |
| `"settings"` | Opt out: delete the var and mask normally. Subtree-effective — a `"settings"` child of a `"defer"` parent un-defers itself and stops propagation to grandchildren (a default-defer grandchild of *it* publishes its own var). |

The var is a **static pid tag**, not live state — no payload, no per-toolset data, no per-`tool_call` publishing. The parent never defers against its own tag (the pid check is stable across `/new` and `/reload`, which stay in-process). A deferring child emits no `restored`/`changed` events — the mask took no action, so there is nothing to notify about.

The semantics: **the spawner owns the child's tools.** Subagent plugins configure their children's tool sets explicitly; the parent's live toggles and context-hygiene pins are about the parent's session, not the child's.

### Caveats — read before relying on defaults

- **The library's "defaults apply" promise is parent-scoped.** With default-defer, `toolsetDefaults` pins are NOT enforced in subagent children whose frontmatter requests those tools — `toolsetDefaults` govern the sessions where masking runs, not children whose spawner explicitly configured their tools. This is deliberate, not a bug. Set `"piToolMasking": { "childPolicy": "settings" }` to restore enforcement in children.
- **Any descendant `pi` below a defer parent defers — including bash-spawned ones.** The var cannot distinguish a subagent child from any other descendant process: a `pi` launched from a bash subshell under a defer parent comes up on packaged defaults, and tools pinned off for context hygiene will be active there. Masking is **context hygiene, not a security boundary** — pi runs with full system access by design (no sandbox, no popups). If a workflow needs pins enforced, set `"childPolicy": "settings"` globally: it covers descendants on the same machine.
- **Pid recycling fails safe.** A stale var whose pid was recycled reads as self → masking applies (enforcement), never silent defer.
- **A spawner that scrubs child env (`env: {}`) drops the channel** — the child silently falls back to enforcing defaults. This is the "why isn't defer working for plugin X" case.
- External-CLI runners (codex-exec etc.) are out of scope — a different runtime; this library isn't loaded there.

## Tombstone helpers

Within pi-core's append-only `SessionManager`, a toolset's chat-branch entry can't be deleted — but a `null` tombstone appended after the last entry makes `doRestore` fall through to settings, so settings re-assert. Tombstones are dedup'd (no-op when the last entry is already cleared) and never written for never-toggled toolsets. A later manual toggle appends after the tombstone and supersedes it.

### `clearToolsetEntry(pi, persistKey, branch)`

Append a `null` tombstone for one toolset's branch entry (dedup'd). `branch` is the caller's `ctx.sessionManager.getBranch()` snapshot — `ExtensionAPI` exposes `appendEntry` but not `sessionManager`, so the dedup read comes from the caller.

### `clearAllToolsetEntries(pi, branch)`

Tombstone every registered toolset's branch entry (dedup'd per toolset). Covers exactly the toolsets in the global registry.

### `forceToolsetEnabled(pi, spec, enabled)`

Apply a toolset's enabled state via `setActiveTools` and emit `TOOLSET_EVENTS.changed` **without** writing a branch entry — the live-apply half of a settings restore (pull a toolset to its settings/packaged default without persisting a chat-branch pin). Like the restore path, it never persists: branch entries come solely from explicit toggles (`enable()`/`disable()`/`toggleBatch()`) and their cascades. An inert toolset (see below) announces `enabled: true`/`enabled: false` through the event while declaring nothing.

This is the actuation primitive that bypasses the intent gate — always applies, always emits, no questions asked, no cascade — and returns `void` by design: it shares the restore path, whose always-emit invariant can never honor the `ToggleResult[]` contract (`[]` ⇔ silent no-op). It is not a substitute for `enable()`/`disable()`, which resolve intent and persist it. Under allowlist governance it is the primary actuation path — interactive toggles throw `AllowlistModeError` there — and it stays live in a deferring child.

---

## Runtime membership changes

A dynamically-managed toolset's member set can change at runtime (an MCP server gaining or losing tools). There is no API for this — mutate the live registry entry returned by `getRegisteredToolsets()` directly:

```ts
const entry = getRegisteredToolsets().find((t) => t.spec.id === "my-tools");
entry.spec.names = new Set(nextNames); // entries are live; this IS the mechanism
```

The `id`, `persistKey`, and registered `ToolsetImpl` instance are unchanged: handles you already hold keep working, no warn-and-replace fires, and persisted on/off state is unaffected. (Do **not** re-call `defineToolset` with a changed spec for the same `id` — that is treated as a code edit after `/reload`: it warns and replaces the registry entry, invalidating handles.)

The contract is scoped to consumers that are the toolset's **membership authority** — toolsets whose spec exists only at runtime. A declared toolset's authority is its spec literal in source: change members by changing code and re-registering; `/reload` re-runs `defineToolset` with the fresh literal and would warn-and-replace any mutation.

Caveats:

- **Data, not action.** Assignment performs no actuation, persistence, or event. When pi manages membership (an MCP server gaining a `direct` tool), the set already matches the desired activation — pi activates declarable members on registration, so actuating would be a no-op. A disabled toolset's newly-added members are removed by the per-turn `before_agent_start` re-assert, which reads the updated `spec.names`. Callers wanting an immediate reconcile can call `forceToolsetEnabled(pi, spec, desired)`.
- **Members pi does not activate on registration.** Activation on registration covers declarable members (`direct`/`model-only`) without `defaultActive: false`. Adding a non-declarable member (`codemode`/`deferred`) or a `defaultActive: false` member to an **on** toolset leaves it undeclared — no event, no self-heal — while `isEnabled()` still reports true. Call `forceToolsetEnabled` yourself after adding such members. (A `hidden` member can never be declared — `forceToolsetEnabled` cannot help; see [Hidden-exposure toolsets and inert state](#hidden-exposure-toolsets-and-inert-state).) Symmetrically, removing a name does not deactivate it: an on toolset can keep declaring a tool it no longer owns until pi itself de-registers or re-hides the tool. Note MCP's *default* exposure is `codemode`, so a toolset over a whole server's tools would include non-activating members.
- **No overlap guard runs.** The name-overlap check is a `defineToolset` registration-time check; raw mutation bypasses it. Assign a **fresh `Set`** — never keep mutating a set after assigning it (no copy-on-store; a retained live reference bypasses even consumer-side discipline).
- **`/reload` resets membership to the code-defined spec.** Persisted on/off state survives, membership does not — the consumer's next scan re-derives and re-applies runtime membership.
- **An emptied toolset still records intent.** Assigning an empty `Set` is permitted; `enable()`/`disable()` on a zero-member toolset resolve and persist the resolved intent (there is nothing to actuate, so no loadout write occurs) — a toggle is silent only when it matches the already-resolved state. A prior branch entry survives emptying and repopulating revives actuation from persisted intent.
- **No event fires.** The mutation is caller-initiated — the caller knows it changed membership and can re-render itself. What is *not* informed is any second-order consumer presenting the member set: nothing announces membership changes, so such consumers must re-read `spec.names` via `getRegisteredToolsets()` instead of caching it.

---

## Hidden-exposure toolsets and inert state

Pi 0.99 gives every tool an `exposure` (`direct | model-only | codemode | deferred | hidden`). `hidden` tools can never enter the active set, so the library's actuation and mask paths filter them out: a `hidden` member of a toolset is never handed to `setActiveTools` and never triggers a redundant mask write on the per-turn re-assert. On pi < 0.99 (no `exposure` field) every registered name is actuatable — behaviour is unchanged.

**Inert toolsets — `enabled` means intent, not observation.** A non-empty toolset with zero actuatable members (members still `hidden`, or its MCP server not yet connected) cannot witness either state: a hidden member can never be active, and absence of activity proves nothing when nothing can be active. For such a toolset:

- an explicit `enable()` that opposes the resolved intent persists the branch entry and emits `changed {enabled: true}` while issuing **no** `setActiveTools` call;
- an explicit `disable()` that opposes the resolved intent persists the off entry and emits `changed {enabled: false}` the same way;
- `isEnabled()` stays `false` in both directions until actuatable members exist.

A toggle matching the already-resolved state is a silent no-op (`[]` from the change report), for inert and fully-registered toolsets alike. (The resolver reads the branch entry, so same-value repeats converge to silence — a toggle that opposes the resolved intent is the deliberate write that repairs or records it.)

This is deliberate: the persisted entry is what makes the toolset spring to life (or stay suppressed) at the next restore event once members become actuatable. Toggles on **partially-registered** toolsets (some members not yet registered) behave the same way — the first toggle that opposes the resolved intent persists and emits, same-value repeats are silent. Only a zero-member toolset records intent without any possibility of actuation (above).

### Intent vs observation

Branch entries record *intent* ("this toolset should be on/off"); `isEnabled()` reports *observation* ("tools from this toolset are in the active set right now"). For an inert toolset the two diverge in both directions, so pick the right signal per use site. Toggles themselves resolve against the intent tier chain, so a toggle on an externally-clobbered toolset still records the user's intent rather than being dropped by what the active set happens to show:

- **Display reads intent** — `effectiveEnabled(spec, branch, readMergedToolsetDefaults())` with `branch` from `ctx.sessionManager.getBranch()` inside a handler. An inert toolset shows its persisted state, and in exclusion mode an "off" toggle is honored rather than refused (under allowlist governance the toggle itself throws `AllowlistModeError` instead). (Reading `isEnabled()` here renders an intent-on inert toolset as "off" and refuses the user's "off"; replaying the event stream is equally wrong — a `changed` event can announce `enabled: true` for a toolset that declares nothing.)
- **"Is anything actually declared right now?" reads observation** — `isEnabled()`. Character counts and declaration-sensitive surfaces care about the active set, not the user's wish.
- **Persisted defaults capture intent, never a mid-session `isEnabled()` snapshot** — capturing observation while a toolset is inert pins a temporary divergence as a permanent misconfiguration.

### Exposure expectations

Keep toolset member sets to `direct`/`model-only` exposure (pi activates those on registration). A `deferred`/`codemode` tool inside a toggled-**off** toolset is not reliably suppressed: `tool_search` still lists it and can load it mid-turn (the per-turn re-assert removes it again at the next turn boundary), and a `codemode` member stays script-callable while off — masking is context hygiene, not a reachability boundary. Toggle the toolset on instead of relying on either edge.

---

## ToolsetSpec fields

```ts
interface ToolsetSpec {
 /** Stable id, e.g. "my-plugin.web". Used in persist keys and event payloads. */
 id: string;

 /** Human-readable name. Optional — falls back to id. */
 label?: string;

 /** One-line description. Optional — omitted when absent. */
 description?: string;

 /** Tool names this toolset governs. */
 names: Set<string>;

 /** Persistence key, e.g. "toolset-state:my-plugin.web". */
 persistKey: string;

 /** Fallback when no branch entry exists. Default true. */
 defaultEnabled?: boolean;

 /** IDs of toolsets that must be enabled for this one. */
 requires?: string[];
}
```

### Key behaviors

- **`requires` cascade:** enabling a toolset automatically enables all its dependencies (recursively). Disabling a toolset automatically disables all dependents.
- **Cycle detection:** circular `requires` relationships throw `CycleError` at toggle time — atomically, before any write or emit.
- **Contradiction refusal:** a toggle batch whose resolved intent is incoherent (an id enabled while a transitive `requires` dependency of it is disabled by the same batch) throws `ContradictionError` — nothing is written; no winner is picked. See [`toggleBatch`](#togglebatchpi-sessionmanager-ops).

---

## Toolset handle

```ts
interface Toolset {
 // Enable all members (+ cascade to deps). Single-op sugar over toggleBatch.
 // sessionManager is a required branch reader — in practice ctx.sessionManager.
 // Returns one ToggleResult ({ id, enabled }) per toolset whose resolved
 // intent changed or whose loadout wrote; [] on a silent no-op.
 enable(pi: ExtensionAPI, sessionManager: BranchReader): ToggleResult[];
 disable(pi: ExtensionAPI, sessionManager: BranchReader): ToggleResult[]; // Disable all members (+ cascade to dependents)
 isEnabled(pi: ExtensionAPI): boolean; // Check if at least one member is active
}
```

The library reads the branch once per toggle call, at that call's boundary — one reader passed once per command stays correct across cascades and loops (each wrapper call re-reads at its own boundary; inside a [`toggleBatch`](#togglebatchpi-sessionmanager-ops) call the pre-computed plan is the intent authority, and the pre-call state resolves from the same single branch read). A toggle persists and emits iff the resolved intent changes or a loadout write occurred; `enabled` in the report is the value that call persisted and emitted — the appended branch entry, the event payload, and the report are always the same value. Reader-handling rules (pass the object,
not a method reference; no branchless fallback) are documented on
[`BranchReader`](#api).

---

## Event payload

```ts
interface ToolsetChangedEvent {
 id: string;        // Toolset id, e.g. "my-plugin.web"
 enabled: boolean;  // New state
}
```

`enabled` carries the recorded intent — the value the toggle wrote (or
re-affirmed), which only exists in exclusion mode: under allowlist
governance toggles throw `AllowlistModeError` and write nothing (see
[`setDefaultResolutionMode`](#setdefaultresolutionmodepi-mode-allowlist)),
so the event payload, the persisted branch entry, and the `ToggleResult`
report always carry the same value. Emits fire only after every write in a
toggle call has completed — a cascade transitions as one coherent sequence
of events, and no synchronous `changed` listener can intercept through the
library's own event channel mid-call. In exclusion mode a synchronous
`changed` listener that appends a same-key entry supersedes the toggle's
entry on the next restore — the report and event still describe the
toggle's own write.

---

## Real-world patterns

### Status bar sync

```ts
pi.events.on(TOOLSET_EVENTS.changed, (event) => {
 if (event.id === "my-plugin.web") {
  renderGlyph(event.enabled);
 }
});

// Also listen to 'restored' so status is correct after /reload
pi.events.on(TOOLSET_EVENTS.restored, (event) => {
 if (event.id === "my-plugin.web") {
  renderGlyph(event.enabled);
 }
});
```

### Focus mode (allowlist resolution)

```ts
import {
 setDefaultResolutionMode,
 forceToolsetEnabled,
 getRegisteredToolsets,
 readBranchModeState,
} from "pi-tool-masking";

// Enter focus: allowlist mode keeps only the listed toolsets on — restore
// applies it on the next /reload, and the loop below applies it live.
setDefaultResolutionMode(pi, "allowlist", ["my-plugin.web"]);

// Apply live via the actuation primitive — enable/disable throw
// AllowlistModeError under allowlist governance, so focus actuation never
// routes through the toggle path. ctx comes from a handler that receives
// one (registerCommand, an event handler, …).
function applyFocus(ctx: ExtensionContext) {
 const { mode } = readBranchModeState(ctx.sessionManager.getBranch());
 if (mode !== "allowlist") return;
 for (const entry of getRegisteredToolsets()) {
  forceToolsetEnabled(pi, entry.spec, entry.spec.id === "my-plugin.web");
 }
}
```

### Dependent toolsets

```ts
// Web tools are on by default; learn tools depend on web
const webSpec: ToolsetSpec = {
 id: "my-plugin.web",
 names: new Set(["web-fetch", "web-snapshot"]),
 persistKey: "toolset-state:my-plugin.web",
 defaultEnabled: true,
};

const learnSpec: ToolsetSpec = {
 id: "my-plugin.learn",
 names: new Set(["web-learn"]),
 persistKey: "toolset-state:my-plugin.learn",
 defaultEnabled: false,
 requires: ["my-plugin.web"], // learn can't be on unless web is on
};
```

---

## Toolset naming

`defineToolset` can't tell which extension is calling it — pi's `ExtensionAPI`
doesn't expose the caller — so error messages can't name the responsible
extension directly. The toolset id is the only traceability signal, which is
why a stable, attributable id convention matters.

### Convention (recommended, not enforced)

Prefix toolset ids with a stable namespace: `<product-family>.<subset>`, e.g.
`my-plugin.web`. The family may span multiple npm packages, and nothing checks
that the prefix matches a real package — it's for human traceability in
`/tbox list` and collision errors, not verification.

### Enforcement floor

`defineToolset` enforces one naming invariant: **no two toolsets may claim the
same tool name.** Overlap is essentially always an authoring mistake and throws
at load time:

```
[pi-tool-masking] name overlap: toolset "foo.search" claims tools already
owned by another toolset:
  - tool "x" already claimed by toolset "bar.web" (registered from
    /home/u/.pi/.../bar/index.ts, source: bar)
Each tool may belong to only one toolset. Naming convention: prefix toolset
ids with a stable namespace (<product-family>.<subset>, e.g. "foo.web").
```

---

## How it works (for the curious)

- **Registration:** `defineToolset` stores the spec and handle in a global registry (shared across module instances, so multiple extensions see the same toolsets).
- **Persistence:** each toolset writes `{ enabled }` entries under its `persistKey` on the session branch. On `session_start` or `session_tree`, the library re-reads the branch and applies the last persisted state.
- **Default resolution:** a `toolset-resolution-mode` entry on the branch controls how toolsets with no persisted state resolve on restore — `exclusion` (on/off by `defaultEnabled`) or `allowlist` (a finite branch-persisted array whose complement is computed at restore). Set by `setDefaultResolutionMode`, persists across reloads.
- **Defaults tiers:** each toolset's restore default resolves chat-branch entry → `toolsetDefaults` settings pin → packaged `spec.defaultEnabled`. Settings pins are read fresh from disk on each restore.
- **Null-tombstone-aware restore:** a `null` last branch entry (written by `clearToolsetEntry`) falls through to the settings tier instead of any stale prior entry; mode resolution is likewise null-tombstone-aware (`readBranchModeState` maps an unrecognized, absent, or tombstoned last entry to `"exclusion"`). Tombstones aren't sticky — a later toggle supersedes them.
- **Events:** a live toggle is silent (no write, no emit) only when both the intent delta is zero and no loadout write occurred — i.e. the resolved intent already matches the requested state and the active set needed no repair. Persist + emit iff the intent changes or a loadout write occurred; this fixes the witnessed-off asymmetry where a user's off toggle on an externally-clobbered toolset was dropped outright. Cascade repeats are silent by construction — the planner's visited set makes each id appear exactly once per call. Emits fire only after all writes complete, so a `changed` listener observes the batch's final state, never an intermediate one. Restore always emits, so side-effect owners stay in sync across reloads and tree navigations.
- **Child-policy defer:** the top of every restore reads `piToolMasking.childPolicy` (default `"defer"`) and manages a static pid-tagged env var (`PI_TOOLMASKING_DEFER`): a defer-policy parent publishes it when absent, a foreign-pid var makes restore and the per-turn re-assert no-op (deferring to the spawner) — and makes `enable`/`disable` silent no-ops (`[]`) and `setDefaultResolutionMode`/`clearToolsetEntry`/`clearAllToolsetEntries` write nothing, while `forceToolsetEnabled`, raw `appendEntry`, and the settings writers stay live — and a `"settings"` policy deletes the var and masks normally. See [Subagent inheritance](#subagent-inheritance-child-policy-defer).

---

## Consumer examples

This package is used by:

- **[pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)** — browser automation and SearXNG search tools toggled via `/web on|off|learn` and `/searxng-status`
- **[pi-tbox](https://github.com/coreyryanhanson/pi-tbox)** — cross-extension tool manager that queries `getRegisteredToolsets()` for its `/tbox toggle` and `/tbox focus` commands

---

## License

MIT. See [LICENSE](./LICENSE).
