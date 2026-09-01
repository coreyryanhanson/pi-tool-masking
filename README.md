# pi-tool-masking

A library for pi plugin developers that groups tools into toggleable **toolsets** with persistent state and cross-extension events — eliminating the boilerplate every pi extension repeats when it wants to let users disable tools cleanly.

`pi-tool-masking` is **not** a pi extension itself. It is a dependency that your extension imports. It owns the toggle logic, the session-restore path, and the event bus. Your extension owns the commands, the status bar, and the user-facing surfaces.

---

## Why use it?

Without `pi-tool-masking`, every pi extension that toggles tools reimplements the same pattern:

1. Maintain a `Set` of active tool names.
2. On enable, add members to `pi.setActiveTools()` and `pi.appendEntry()` a persist record.
3. On disable, filter members *out* of `pi.getActiveTools()` and append a persist record.
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
  handler: async (args) => {
   if (args.trim() === "on") {
    webToolset.enable(pi);
   } else if (args.trim() === "off") {
    webToolset.disable(pi);
   }
  },
 });
}
```

That's it. The toolset is registered, its members are managed, and state persists across reloads, resumes, and tree navigations — no `appendEntry` or `session_start` restore code required.

---

## API

### `defineToolset(pi, spec)`

Register a toolset and receive a `Toolset` handle (`enable`, `disable`, `isEnabled`).

| Parameter | Type | Required |
|---|---|---|
| `pi` | `ExtensionAPI` | Yes — the pi extension API instance |
| `spec` | `ToolsetSpec` | Yes — the toolset definition |

**Idempotent re-registration:** calling `defineToolset` with the same `spec.id` and an unchanged spec returns the existing toolset. This is safe across `/reload`.

### `setDefaultResolutionMode(pi, mode, allowlist?)`

Switch how toolsets with no persisted state resolve on restore. Three modes:

| Mode | Behavior on restore (no persisted entry) |
|---|---|
| `"exclusion"` (default) | Toolsets default **on** if `defaultEnabled` is true, **off** otherwise |
| `"inclusion"` (@deprecated since 1.2.0) | All unknown toolsets default **off** — a weaker, unbounded floor. Use `"allowlist"` instead for focus-style "only these tools" suppression |
| `"allowlist"` | Only the listed toolset ids are **on**, everything else **off** — a finite, branch-persisted set whose complement is computed at restore, resilient to toolsets installed later. Pass the array as the third argument: `setDefaultResolutionMode(pi, "allowlist", ["my-plugin.web"])` |

### `getDefaultResolutionMode()`

Read the current default resolution mode. Returns `"exclusion"` until a session restore loads the persisted mode.

### `getActiveAllowlist()`

Read the live allowlist array from module state. Returns the `string[]` when the active mode is `"allowlist"`, otherwise `undefined`. Parameterless (like `getDefaultResolutionMode`) — the downstream call site receives `ExtensionAPI`, which doesn't expose `sessionManager`, so the branch can't be read there. The branch remains the source of truth; module state is the live mirror, snapped from the last mode branch entry by `doRestore` (and by `setDefaultResolutionMode` when it appends the entry). A consumer consults this to keep toolsets registered *after* focus was entered off.

### `getRegisteredToolsets()`

Return a read-only snapshot of every registered toolset (`{ spec, toolset }`). No `pi` argument needed — pure registry read.

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
| `RegistryEntry` | `{ spec: ToolsetSpec; toolset: Toolset }` — a single registered toolset |
| `DefaultResolutionMode` | `"exclusion" \| "inclusion" \| "allowlist"` |
| `MalformedSettingsError` | Thrown by `writeToolsetDefaults` / `clearToolsetDefaults` when settings.json is corrupt or non-object (never silently overwritten). Catch with `instanceof`. |

---

## Toolset defaults (settings tier)

A toolset's fresh-session default is no longer locked to its packaged `spec.defaultEnabled`. Users can pin `{ enabled: boolean }` under a reserved `toolsetDefaults` key in pi-core settings, keyed by the toolset's full `persistKey` — without toggling (which writes a session-scoped chat-branch entry). The library reads both files itself inside `doRestore`, fresh on each `/reload`, so downstream consumers no longer need to reinvent a settings reader to inject values into `spec.defaultEnabled` before `defineToolset`.

Restore resolves each toolset's default in this order (first hit wins):

1. **Chat-branch entry** — the last `appendEntry(persistKey, …)` on this branch. A `null` tombstone (see [`clearToolsetEntry`](#tombstone-helpers)) falls through to the tiers below.
2. **Env mirror** — `PI_TOOLMASKING_LIVE_STATE` inherited from a parent process at spawn, consumed once at the child's first restore (see [Subagent inheritance](#subagent-inheritance-env-mirror)). Present only in a freshly spawned child.
3. **Settings pin** — `toolsetDefaults[persistKey].enabled`, merged global → project (project wins per entry). Mode-agnostic.
4. **Packaged default** — `spec.defaultEnabled ?? true`, filtered by resolution mode for unpinned toolsets only.

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

Resolve a toolset's effective fresh-session default: settings tier (3) then packaged `spec.defaultEnabled ?? true` (4). **Ignores resolution mode** — callers needing mode-aware behavior must consult `getDefaultResolutionMode()` themselves. Also ignores the env-mirror tier (that tier exists only in live restore resolution). Pass an explicit `snapshot` (from `readMergedToolsetDefaults()`) when looping over multiple toolsets; omit it for a one-off (it performs its own read).

## Subagent inheritance (env mirror)

Fresh child sessions spawned by subagent plugins re-resolve toolset state from settings — the parent's interactive toggles are chat-branch entries and don't cross the process boundary, so children silently land on settings defaults. This library fixes that by mirroring the parent's **live** toolset state into the process environment — the one channel every spawn path already shares (`child_process.spawn` inherits the parent env by default). A freshly spawned child consumes it once at its first `session_start` / `session_tree`, then resolves normally. No settings changes, no child-detection heuristics, nothing persisted to disk. Grandchildren work the same way: the publisher runs in children too, so a child re-publishes from its own post-restore state at its next dispatch.

`PI_TOOLMASKING_LIVE_STATE` is a **consumer-only** contract: only this library writes the var. Other plugins consume it at their peril — there is no two-way contract.

1. **Envelope format** — `{ v: 1, pid, boot, state }` where `state` is `Record<persistKey, { enabled: boolean }>` for every registered toolset (toolsets whose members all fail to register are omitted). Booleans only, by design: env vars are a dump vector (crash reporters, `set -x`, CI capture), so the envelope must never grow beyond inert booleans. A toolset is mirrored `on` iff every **registered** member is in `getActiveTools()` — a deliberate divergence from `Toolset.isEnabled()` (`.some()`): the mirror reflects the fully-restored mask, which is what a child should inherit. Any envelope violation (corrupt JSON, bad shape, unknown version, >64KB) fails closed — the var is deleted with one log line and the child resolves from settings; individual malformed entries are inert at resolution.
2. **Precedence tier** — chat-branch entry → env mirror → settings pin → mode floor → packaged default. A valid foreign mirror **outranks explicit settings pins** for that session. Mirror-resolved toolsets emit `restored` (not `changed`) at child `session_start`. The consumed map survives `session_tree` and `/reload` in the child, and is cleared on a same-process session switch (`/new`, `/resume`) so a stale inherited mask never shadows the resumed session's own state.
3. **`PI_TOOLMASKING_NO_INHERIT`** — consumer opt-out, the escape hatch for the mirror-over-pin precedence above. Set it and the child skips the mirror tier entirely, resolving from settings (and the mirror var is still deleted, so it doesn't leak into the opt-out child's own spawns). The opt-out var itself is never deleted and propagates to grandchildren: set it once (operator or CI harness) and the whole subtree opts out. That's the point — don't scrub it.
4. **Limitations** — one line each:
   - A spawning plugin that scrubs child env (`env: {}`) loses the channel — silent fallback to defaults. Genuine pi-core gap.
   - External-CLI runners (codex-exec etc.) are out of scope — a different runtime; this library isn't loaded there.
   - Inheritance is all-or-nothing — no per-lane overrides.
   - The mirror carries **observed live state, not operator intent**: a parent that never touched toolset X still publishes it `on` (under the default exclusion mode), silently overriding a child's settings pin `off` — the inverse of the bug this fixes.
   - A toggle made after the parent's last lifecycle publish, spawning from a slash-command handler with no intervening `tool_call`, inherits pre-toggle state. Narrow — most spawns go through the `subagent` tool (a `tool_call`).
   - A plugin using `context: "fork"` doesn't need the mirror — branch-entry replay already outranks it on that path.
   - The standing mirror leaks into any nested or top-level `pi` process while a session is live (`session_start { reason: "startup" }` is indistinguishable from a spawned child's); consumed as genuine inheritance, bounded by the mandatory `session_shutdown` cleanup. No cheap code fix.
   - `isEnabled()` uses `.some()` while the mirror uses all-registered-members (deliberate divergence — see above).
   - `getEffectiveDefault()` does not see the mirror tier; live resolution is `effectiveEnabled`.
5. **Retirement condition** — the mirror is removed when pi-core provides an official mechanism for parent-side extension state to reach a spawned child session (spawn/launch hook with extension-contributed bindings, a child-visible parent-context API, or an official inherit-state contract in the child spawn path). The trigger is the pi-core capability, not any one subagent plugin's behavior — only a pi-core channel retires the bridge.

## Tombstone helpers

Within pi-core's append-only `SessionManager`, a toolset's chat-branch entry can't be deleted — but a `null` tombstone appended after the last entry makes `doRestore` fall through to the env-mirror tier in a freshly spawned child and otherwise to settings, so settings re-assert. Tombstones are dedup'd (no-op when the last entry is already cleared) and never written for never-toggled toolsets. A later manual toggle appends after the tombstone and supersedes it.

### `clearToolsetEntry(pi, persistKey, branch)`

Append a `null` tombstone for one toolset's branch entry (dedup'd). `branch` is the caller's `ctx.sessionManager.getBranch()` snapshot — `ExtensionAPI` exposes `appendEntry` but not `sessionManager`, so the dedup read comes from the caller.

### `clearAllToolsetEntries(pi, branch)`

Tombstone every registered toolset's branch entry (dedup'd per toolset). Covers exactly the toolsets in the global registry.

### `applyToolsetEnabled(pi, spec, enabled)`

Apply a toolset's enabled state via `setActiveTools` and emit `TOOLSET_EVENTS.changed` **without** writing a branch entry — the live-apply half of a settings restore (pull a toolset to its settings/packaged default without persisting a chat-branch pin).

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

 /** When true, toggles emit one event per member in addition to the group event. */
 emitMemberEvents?: boolean;
}
```

### Key behaviors

- **`requires` cascade:** enabling a toolset automatically enables all its dependencies (recursively). Disabling a toolset automatically disables all dependents.
- **Cycle detection:** circular `requires` relationships throw at toggle time.
- **`emitMemberEvents`:** opt into per-member fan-out events so a per-tool UI updates without the manager re-deriving which members moved.

---

## Toolset handle

```ts
interface Toolset {
 enable(pi: ExtensionAPI): void;   // Enable all members (+ cascade to deps)
 disable(pi: ExtensionAPI): void;  // Disable all members (+ cascade to dependents)
 isEnabled(pi: ExtensionAPI): boolean; // Check if at least one member is active
}
```

---

## Event payload

```ts
interface ToolsetChangedEvent {
 id: string;        // Toolset id, e.g. "my-plugin.web"
 enabled: boolean;  // New state
 member?: string;   // Present only when emitMemberEvents is on — the specific tool that changed
}
```

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
import { setDefaultResolutionMode, getRegisteredToolsets } from "pi-tool-masking";

// Enter focus: allowlist mode keeps only the listed toolsets on — restore
// applies it on the next /reload, and the loop below applies it live.
// "inclusion" (deprecated) cannot guarantee this: a toolset installed after
// focus leaks on, because the set of "on" toolsets was never recorded.
setDefaultResolutionMode(pi, "allowlist", ["my-plugin.web"]);

// Apply live: enable only the allowlisted toolsets
const allowlist = new Set(["my-plugin.web"]);
for (const entry of getRegisteredToolsets()) {
 if (allowlist.has(entry.spec.id)) {
  entry.toolset.enable(pi);
 } else {
  entry.toolset.disable(pi);
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
- **Default resolution:** a `toolset-resolution-mode` entry on the branch controls how toolsets with no persisted state resolve on restore — `exclusion` (on/off by `defaultEnabled`), `inclusion` (deprecated unbounded floor), or `allowlist` (a finite branch-persisted array whose complement is computed at restore). Set by `setDefaultResolutionMode`, persists across reloads.
- **Defaults tiers:** each toolset's restore default resolves chat-branch entry → env mirror (in a freshly spawned child; see [Subagent inheritance](#subagent-inheritance-env-mirror)) → `toolsetDefaults` settings pin → packaged `spec.defaultEnabled`, filtered by resolution mode for unpinned toolsets only. Settings pins are read fresh from disk on each restore.
- **Null-tombstone-aware restore:** a `null` last branch entry (written by `clearToolsetEntry`) falls through to the settings tier instead of any stale prior entry; mode resolution is likewise null-tombstone-aware (`branchMode ?? "exclusion"`). Tombstones aren't sticky — a later toggle supersedes them.
- **Events:** a live toggle emits only when state actually changes (no-op toggles are suppressed); restore always emits, so side-effect owners stay in sync across reloads and tree navigations.
- **Env mirror:** the parent re-snapshots every registered toolset's live state into `PI_TOOLMASKING_LIVE_STATE` on each `tool_call` and at the end of restore (post-consume), delta-gated against the current env value. A fresh child reads-and-deletes the var at the top of its first restore — before the allowlist short-circuit — and holds the map on `globalThis` so the `before_agent_start` re-assert sees the same inheritance. An identity guard (pid + per-process boot id) ignores stale self-mirrors (e.g. after `/new`), and a `session_shutdown` handler deletes the standing mirror.

---

## Consumer examples

This package is used by:

- **[pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)** — browser automation and SearXNG search tools toggled via `/web on|off|learn` and `/searxng-status`
- **[pi-tbox](https://github.com/coreyryanhanson/pi-tbox)** — cross-extension tool manager that queries `getRegisteredToolsets()` for its `/tbox toggle` and `/tbox focus` commands

---

## License

MIT. See [LICENSE](./LICENSE).
