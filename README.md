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

`pi-tool-masking` does all of that in one call: `defineToolset(pi, spec)`. It also adds dependency cascading (enabling a toolset auto-enables its dependencies) and reverse cascading (disabling a toolset auto-disables dependents).

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
- **Default resolution:** a single `toolset-resolution-mode` entry on the branch controls whether unknown toolsets default on or off. This is set by `setDefaultResolutionMode` and persists across reloads.
- **Events:** a live toggle emits only when state actually changes (no-op toggles are suppressed); restore always emits, so side-effect owners stay in sync across reloads and tree navigations.

---

## Consumer examples

This package is used by:

- **[pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)** — browser automation and SearXNG search tools toggled via `/web on|off|learn` and `/searxng-status`
- **[pi-tbox](https://github.com/coreyryanhanson/pi-tbox)** — cross-extension tool manager that queries `getRegisteredToolsets()` for its `/tbox toggle` and `/tbox focus` commands

---

## License

MIT. See [LICENSE](./LICENSE).
