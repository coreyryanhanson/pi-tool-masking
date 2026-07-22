# pi-tool-masking — Design Document

> Status: draft (pre-implementation). API is not yet frozen; this document
> is the source of truth until v1.0.0.

## 1. Purpose

This repository is the **core library** layer of a two-layer design:

1. **`pi-tool-masking` (this package)** — a pure library. It registers
   **no tools, no commands, no event handlers** with the running pi
   process. It exports plain functions (`defineToolset`,
   `registerToggleCommand`, `TOOLSET_EVENTS`) that *other* pi extensions
   call. It is not a pi extension in the runtime sense (no default
   `(pi: ExtensionAPI) => ...` factory); it is a library that targets the
   pi extension API, the same way a React hook library targets React
   without being a component.
2. **A separate user-facing extension** (deferred, out of scope for this
   repo — see §13) — a real pi extension that depends on
   `pi-tool-masking`, queries the registered toolsets, and offers the
   cross-extension "toggle any toolset" surface plus user-tagged groups.

The library centralizes the logic for grouping tools into toggleable
**toolsets** and remembering which toolsets are active across pi-session
boundaries (`/reload`, `/resume`, `/fork`, `/tree` navigation). It is
extracted from the near-identical toggle implementations in
`pi-lean-portal` (`browser-toggle.ts`) and `pi-lean-host` (`api-toggle.ts`),
which duplicate ~90% of their structure: a tool-name Set, an
additive-on / filter-off `setActiveTools` dance, an `appendEntry`-based
persistence schema, and a `session_start`/`session_tree` restore path.

`pi-tool-masking` is a **hard dependency** of portal and host. It lives in
its own repository and is consumed via a static `import` — not a
`globalThis` feature-detect, not an optional peer. If the package is
absent, portal/host fail to load.

## 2. Goals

1. **De-duplicate** the toggle logic across portal and host.
2. **Centralize the peer-composition invariant** (the
   additive-on / filter-off-from-`getActiveTools()` rule) so it cannot
   drift between consumers.
3. **Own conversation-state memory** for toolset on/off status —
   consumers stop writing `appendEntry` / `session_start` restore code.
4. **Decouple side-effects via `pi.events`** so a toggle actuator and its
   side-effect owner (e.g. portal toggling, search updating its status
   glyph) need no import coupling.
5. **Enable a future manager extension** to offer user-tagged tool
   groups (`on`/`off`/`focus` on tagged lists) without the library's own
   API changing — the registry + event surface (§6.1, §6) already expose
   what such a manager needs.

## 3. Non-goals

- **Not** a framework. The public API is ~3 exports. The moment
  `ToolsetSpec` sprouts fields only one consumer uses, this has become
  the wrong abstraction.
- **Not** a tool marketplace or discovery layer. Consumers register
  toolsets they already define; the package never invents tools.
- **Not** a home for consumer-specific conversation config. Portal's
  `defaultProfile` stays in portal (see §7).
- **No** per-tool runtime hooks. Change notification is `pi.events`,
  not custom callback registration (see §6).

## 4. Core concepts

The library operates on two orthogonal axes. Keeping them separate is
the key to not over-building:

- **Activation** (on/off) — whether a tool is in the LLM's active tool
  set, driven by `pi.setActiveTools()`. Runtime state, changes on every
  toggle.
- **Addressability** (masked/unmasked) — whether a tool is reachable *as
  an individual* or *only through its group*. A structural declaration
  on the spec, fixed at registration. This is what "masking" means in
  this library: the group hides its members from individual addressing —
  in the generated command surface, in the downstream picker (§13), in
  tagging, in every surface that enumerates "what can I act on."

`pi.setActiveTools` is flat and the platform cannot stop a rogue
extension from naming a masked group's members directly — that is an
activation-level action the library cannot police. What `masked`
guarantees is that **every surface the library exposes and every
command it generates** treats masked members as reachable only via the
group. It is an addressability contract, not a platform enforcement.

### 4.1 Toolset

A named group of tool names governed as a unit for toggling. Each toolset
has:

- an `id` (e.g. `"portal.web"`, `"portal.learn"`, `"host.api"`)
- a `names` Set of tool names it governs
- an optional status-bar `slot` + `glyphs`
- a `persistKey` (the new write key, e.g. `toolset-state:portal.web`)
  for branch-aware state memory, plus optional `legacyPersistKeys` for
  one-cycle migration reads from pre-extraction entry names
- an optional `configKey` + `defaultEnabled` for fresh-session config-file
  defaults
- an optional `masked` flag (addressability — see §4.2)
- an optional `emitMemberEvents` flag (see §6)

There is **no `learn` field**. "Learn mode" is not a grouping primitive;
it is a two-toolset pattern a consumer composes at the call site (base
toolset + extended toolset, where "learn" = both on). See §4.3 and §10.

A toolset tolerates `names` that aren't currently registered (filtered to
the registered subset at actuation time, matching today's `getRegisteredIn`
helper). This lets a consumer define a toolset before all its tools are
loaded, and keeps a toolset non-fatal if a sibling package is absent.

### 4.2 Masked vs unmasked (addressability)

`masked: true` means the group is the addressable unit: members are not
individually reachable through any surface the library generates or
exposes (command subcommands, registry enumeration, downstream picker
derivation). `masked: false` (default) leaves members individually
addressable. `setActiveTools` is always flat — "inseparable" is enforced
as an addressability contract at the surface layer, never by routing
tricks, and never against a caller that bypasses the library.

### 4.3 Toolset composition

A toolset that includes another toolset's members (e.g. "portal base +
learn") is just a second toolset whose `names = base.names ∪
learn.names` — a value union at the call site, no new mechanism.
Referencing other toolsets *by id* (resolving membership through the
registry at actuation time) is deferred: it only earns its keep if
toolset membership changes dynamically after registration, which nothing
today does.

## 5. Public API (proposed, pre-freeze)

The entire surface — keep it this small. This is a **library API**
(imported by other extensions), not an extension factory.

```ts
// index.ts — plain exports, no default factory

export interface ToolsetSpec {
  /** Stable id, e.g. "portal.web". Used in persist keys and event payloads. */
  id: string;
  /** Tool names this toolset governs. */
  names: Set<string>;
  /** Status-bar slot, e.g. "browser". Omit for toolsets with no glyph. */
  slot?: string;
  /** Per-state glyphs for the slot. */
  glyphs?: { on: string; off: string };
  /** Primary persistence key the toolset writes, e.g.
   *  "toolset-state:portal.web". */
  persistKey: string;
  /** Legacy entry names to read during the one-cycle migration window
   *  (see §8), e.g. ["web-toggle-state"]. Generic — the library never
   *  hardcodes consumer history. */
  legacyPersistKeys?: string[];
  /** settings.json block for fresh-session default, e.g. "browserToggle". */
  configKey?: string;
  /** Fresh-session default when no branch state and no config value. */
  defaultEnabled?: boolean;
  /** Addressability: when true, members are reachable only via the group
   *  in every surface the library generates or exposes (§4.2). Default false. */
  masked?: boolean;
  /** When true, a group toggle also emits one `changed` event per member
   *  tool, for per-tool UIs (the downstream picker, §13). Default false:
   *  one group-level event per toggle. */
  emitMemberEvents?: boolean;
}

export interface Toolset {
  enable(pi: ExtensionAPI, ctx: ExtensionContext): void;
  disable(pi: ExtensionAPI, ctx: ExtensionContext): void;
  isEnabled(pi: ExtensionAPI): boolean;
}

export function defineToolset(pi: ExtensionAPI, spec: ToolsetSpec): Toolset;

export interface ToggleCommandOptions {
  command: string;                       // e.g. "web", "api"
  toolsets: Toolset[];                   // toolsets this command governs
  // Subcommand wiring: the package generates on/off/status from the
  // toolsets. "learn" and other multi-toolset compositions are NOT
  // generated — the library doesn't know which toolsets to compose
  // (learn is a consumer pattern, §4.1). Consumer-specific subcommands
  // (portal's /web learn, /web profile, /web cookies) are supplied via
  // an override hook. To be finalized in implementation; lean toward
  // generated-by-default + override.
  // ...
}

export function registerToggleCommand(
  pi: ExtensionAPI,
  opts: ToggleCommandOptions,
): void;
```

## 6. Change notification: `pi.events`, not custom hooks

The package emits typed events on every toolset status change. Consumers
listen with `pi.events.on(...)`. There are **no per-tool callback hooks** —
a custom hook system would reinvent the documented cross-extension bus
with worse decoupling.

```ts
export interface ToolsetChangedEvent {
  id: string;
  enabled: boolean;
}

export const TOOLSET_EVENTS = {
  /** Emitted on enable/disable (and, if emitMemberEvents is set, once per
   *  member tool with that tool's name in `id`). */
  changed: "toolset:changed",    // ToolsetChangedEvent
  /** Emitted after session_start / session_tree restore re-applies state. */
  restored: "toolset:restored",  // ToolsetChangedEvent
} as const;
```

This replaces portal's current `setSearchSlot()` reach into search's
status slot: portal emits nothing, search listens for `restored`/`changed`
for the `portal.web` toolset and owns its own `search` glyph. Portal no
longer references search.

`emitMemberEvents` is the one forward-compat knob for the downstream
picker (§13): a group toggle can fan out to one event per member so a
per-tool UI updates without the manager re-deriving membership. Default
`false` keeps today's one-event-per-group behavior.

### 6.1 Shared registry on `globalThis` (cross-instance)

`defineToolset` records each toolset in an internal registry so a
*separate* extension (the deferred user-facing manager, §13) can query
"which toolsets exist across all installed extensions" and toggle them.

That registry **must live on `globalThis`, not module-level state**.
Pi installs each package with separate module roots (per `packages.md`:
"Pi loads packages with separate module roots, so separate installs do
not collide or share modules"), so portal, host, and the manager each
get their own copy of the `pi-tool-masking` module under their own
`node_modules/`. Module-level state (a `Map` registry) would fragment:
portal registers into its copy, the manager reads its own empty copy.

`globalThis.__piToolMaskingRegistry` (idempotently initialized by every
copy of the library) converges all instances on one registry regardless
of how many times jiti loads the module. This is the same pattern already
proven in `pi-lean-portal`'s `portal-projection.ts` boundary-safe
detection (`globalThis.__piLeanPortalRegisterGuideProvider`).

The registry stores each toolset's `spec` (at minimum `id`, `names`,
`masked`) plus the `Toolset` object, keyed by `spec.id`. The manager
extension queries it and calls `toolset.enable(pi, ctx)` /
`disable(pi, ctx)` with its **own** `pi`/`ctx` — all extensions in a pi
session share the same underlying runtime, so `setActiveTools` /
`appendEntry` issued through the manager's `pi` act on the same
session state the registering extension would touch. Passing `pi` /
`ctx` explicitly to each call (rather than capturing them at
`defineToolset` time) keeps the registry from holding session-bound
references that could go stale across `/reload` / `/resume`.

Exposing `names` + `masked` in the registry is what lets the downstream
picker (§13) derive addressable units: a tool is individually
addressable iff it is not a member of any masked toolset. The library
does not provide a `getToggleUnits()` helper — that derivation is
trivial and belongs to the manager, not the library (building it here
is the framework smell §3 warns against).

The important boundary: **toggle actuation stays a static import** —
portal calls `defineToolset` directly, the hard-dep story from §1 holds,
no globalThis needed for that path. Only the **registry** — the part that
exists specifically to be observed by a separate extension that is NOT a
static-import consumer — uses globalThis. Clean split, proven pattern.

## 7. Conversation-state ownership

The package owns **toolset on/off memory only**. Each toolset
persists `{ enabled }` under its `persistKey` (the new
`toolset-state:<id>` key), with a one-cycle legacy-read path over
`legacyPersistKeys` (§8), and restores it on `session_start` +
`session_tree`.

**Consumer-specific conversation config does NOT move.** The motivating
case is portal's `defaultProfile` field, which today rides inside the
`web-toggle-state` entry:

```ts
// portal today — overloaded entry
interface BrowserToggleState {
  browserToolsEnabled: boolean;   // ← portal.web toolset state (moves to pi-tool-masking)
  learnToolsEnabled: boolean;     // ← portal.learn toolset state (moves to pi-tool-masking)
  defaultProfile: string;         // ← portal-specific (stays in portal)
}
```

Clean split:

- `pi-tool-masking` writes `toolset-state:portal.web` = `{ enabled }`
  and `toolset-state:portal.learn` = `{ enabled }` — two independent
  entries (learn is its own toolset now, §4.1).
- `pi-lean-portal` writes its own `pi.appendEntry("portal-conversation-state",
  { defaultProfile })` on profile change.

Two entries, two owners, zero coupling. The package's schema never learns
what a browser profile is, and never grows a generic `extra?: Record` bag
(that would be the framework smell). Portal's `setConversationDefaultProfile`
calls one extra `appendEntry` — negligible cost.

### 7.1 Restore independence

Each toolset restores from its own `toolset-state:<id>` entry. Portal's
restore does not depend on host's `session_start` handler firing first,
and vice versa. The only cross-toolset observer is search (for its slot
glyph), and it reacts to the `restored` event rather than to handler
ordering — which also eliminates the current
portal-`session_start`-vs-search-`session_start` race.

## 8. Legacy persistence migration

For one release cycle, `restore()` scans the branch for both the toolset's
`persistKey` and any `legacyPersistKeys` (e.g. `web-toggle-state`,
`api-toggle-state`). The legacy entries were overloaded blobs
(`{ browserToolsEnabled, learnToolsEnabled, defaultProfile }`); each
toolset reads only the boolean that maps to its own `enabled` and ignores
the rest (portal's `defaultProfile` is read by portal, not the library —
§7). So `portal.web` reads `browserToolsEnabled`, `portal.learn` reads
`learnToolsEnabled`, `host.api` reads `apiToolsEnabled`, etc. After that
cycle the `legacyPersistKeys` array is cleared from each consumer's spec
and the legacy read path goes dead.

```ts
// ponytail: legacy web-toggle-state / api-toggle-state read path.
// Drop in the release after portal+host ship the new persistKey.
```

Without this, `/resume` into a branch created before the migration
silently loses toggle state — the data-loss class that must not be cut.

## 9. The peer-composition invariant (load-bearing)

The single most important line in the package. Lives in `disable()`:

```ts
disable(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const current = pi.getActiveTools();        // NOT getAllTools()
  pi.setActiveTools(current.filter((n) => !this.spec.names.has(n)));
}
```

`enable()` is additive: `[...new Set([...current, ...registered])]`,
where `registered` is `spec.names` filtered to tools actually present in
`pi.getAllTools()` (see §4 — a toolset tolerates unregistered names).

`ctx` is required on every method because the library owns the status-bar
slot contract: `enable`/`disable` call `ctx.ui.setStatus(spec.slot,
glyph)` from `spec.glyphs` after applying the active-tool change and
before emitting `TOOLSET_EVENTS.changed`. Consumers that want custom
glyph logic can omit `spec.slot`/`spec.glyphs` and drive the slot
themselves off the event.

**Why `getActiveTools()` and not `getAllTools()` on disable:** using
`getAllTools()` would re-activate every registered tool outside this
toolset's set, silently re-enabling tools another toggle (e.g. host's
`/api off`) has already disabled. This is the bug class the extraction
exists to kill. One copy, one test, one place to break it.

The canonical test: two toolsets A and B, both enabled; disable A; assert
B's tools remain active and A's are gone. Disable B; assert A's tools are
*not* re-activated.

## 10. Consumer integration (post-extraction)

### pi-lean-portal

`browser-toggle.ts` collapses from ~450 lines to roughly:

```ts
import { defineToolset, registerToggleCommand } from "pi-tool-masking";

const webToolset = defineToolset(pi, {
  id: "portal.web",
  names: BROWSER_TOOL_NAMES,
  slot: "browser",
  glyphs: { on: "● idle", off: "○ web off" },
  persistKey: "toolset-state:portal.web",
  legacyPersistKeys: ["web-toggle-state"],   // one-cycle migration read
  configKey: "browserToggle",
  defaultEnabled: true,
});

const learnToolset = defineToolset(pi, {
  id: "portal.learn",
  names: LEARN_TOOL_NAMES,
  persistKey: "toolset-state:portal.learn",
  legacyPersistKeys: ["web-toggle-state"],   // same legacy entry, read during migration
  defaultEnabled: false,                     // learn starts off
});

registerToggleCommand(pi, { command: "web", toolsets: [webToolset, learnToolset], /* ... */ });
```

The `/web` command handler composes the three states from the two
toolsets — this is the "learn is a two-toolset pattern" from §4.1:

```ts
// /web on    → web.enable(pi, ctx);  learn.disable(pi, ctx);
// /web learn → web.enable(pi, ctx);  learn.enable(pi, ctx);
// /web off   → web.disable(pi, ctx); learn.disable(pi, ctx);
```

- `SIBLING_TOOL_NAMES` / `setSearchSlot` block: **deleted**. Search's slot
  is now search's problem, driven by `pi.events`.
- `defaultProfile`: portal keeps a separate `appendEntry`.
- `restoreFromBranch` / `applyConfigDefault` / `session_start` restore
  wiring: **deleted** — owned by `defineToolset`.

### pi-lean-host

`api-toggle.ts` collapses the same way against `host.api` /
`api-toggle-state`.

### pi-lean-search

Adds a listener:

```ts
pi.events.on(TOOLSET_EVENTS.changed, ({ id, enabled }) => {
  if (id === "portal.web") updateSearchGlyph(enabled);
});
pi.events.on(TOOLSET_EVENTS.restored, ({ id, enabled }) => {
  if (id === "portal.web") updateSearchGlyph(enabled);
});
```

Portal no longer references search at all.

## 11. Dependency & versioning strategy

- `pi-tool-masking` is a hard `dependency` of portal, host, and search —
  **not** a `peerDependency`. A hard dep is not a user choice. (Search
  depends on it for the `TOOLSET_EVENTS` constant it listens for in §10;
  portal and host depend on it for `defineToolset` /
  `registerToggleCommand`.)
- Pin `"pi-tool-masking": "^1.0.0"` (or `"1.x"`) in each consumer's
  `package.json`.
- Lockstep versioning across the **four** repos (pi-tool-masking +
  portal + host + search), mirroring the monorepo's existing
  `scripts/sync-versions.js` discipline. A semver-major change in the
  masking package forces coordinated releases across all four.
- No build step — source-only TS loaded by jiti, same as every pi
  extension.

## 12. Testing strategy

- **In `pi-tool-masking`'s repo:** a MockPI that records
  `setActiveTools` / `appendEntry` calls. The canonical test is the
  peer-composition invariant from §9. Plus persistence round-trip
  (write → restore → assert re-applied) and the legacy-key read path.
- **In `pi-lean-portal` / `pi-lean-host`:** thin integration tests that
  call `defineToolset` against a MockPI, plus consumer-specific glyph /
  command tests. **Do not** duplicate the invariant tests here — one
  home for the invariant, one test. Duplicated invariant tests across
  two repos is the framework smell.

## 13. Deferred: user-facing manager extension

A **separate, real pi extension** (not this repo) that depends on
`pi-tool-masking` and provides the end-user upgrade path:

- a cross-extension "toggle any installed toolset" surface (queries the
  globalThis registry from §6.1, calls `Toolset.enable/disable` across
  all registered toolsets regardless of which extension owns them),
- user-tagged tool groups (`on`/`off`/`focus` on tagged lists),
- whatever UI (command, TUI component, status surface) the manager wants
  to present.

Because the manager is a separate extension, the upgrade path is
**opt-in**: users who don't install it get exactly today's experience
(portal's `/web`, host's `/api`). Users who do install it get the unified
cross-extension surface. The library's API needs no change to support it
— the registry + `TOOLSET_EVENTS` already expose everything the manager
needs.

### 13.1 Addressability, tagging, and the picker

The manager's picker renders "all available tools, except masked-group
members show as their group" — the addressability axis from §4. This is
**derived, not stored**: the manager enumerates registry toolsets and
computes the addressable-unit list:

- a **masked** toolset → one unit (the group); its members are suppressed
  from the individual list (they have traded individual addressability
  for group addressability);
- an **unmasked** toolset → its members are individual units; the group
  may appear as a convenience "select all" card, but that is a manager UI
  choice, not a library concern;
- a standalone tool (no toolset) → an individual unit.

Tags are user-assigned labels on **addressable units** (tools or groups),
stored in the manager's own user config. The library never knows what a
tag is. `on`/`off`/`focus` on a tag resolves the tag → its addressable
units → activates/deactivates each. Because a masked group's members are
not addressable units, they cannot be tagged individually — the user tags
the group, and the operation hits the group as a whole. This is the
"trade visibility with group abstraction" behavior, and it falls out of
the two-axis model with no new library machinery: `masked` is the single
source of truth, and every surface (commands, picker, tagging) respects
it.

`emitMemberEvents` (§6) is the one library-side affordance the picker may
opt into: a group toggle can fan out to one `changed` event per member so
a per-tool UI updates without the manager re-deriving which members moved.
Default `false`; the manager sets it on toolsets it renders per-tool.

Also still deferred (orthogonal to the manager):

- **`masked` enforcement against direct `setActiveTools` bypass.** The
  library enforces addressability at every surface it generates or
  exposes; it cannot police a rogue extension calling
  `pi.setActiveTools(["masked-member"])` directly (§4). No need to
  encode deeper until a real threat model requires it.

## 14. Publishing & gallery visibility

`pi-tool-masking` is a library, not a user-facing pi extension. Two
decisions, both independent:

- **Runtime**: pi treats it as an npm `dependency` of portal/host (per
  `packages.md`: "Dependencies that do not register extensions, skills,
  prompt templates, or themes also belong in `dependencies`"). It is
  not auto-discovered as an extension — no default factory, nothing in
  `extensions/`, nothing in a `pi` manifest.
- **Gallery**: the [package gallery](https://pi.dev/packages) lists
  packages tagged `pi-package` in `package.json` `keywords`. **Do not
  tag the library.** Tag the consumer packages (portal, host, and the
  future manager extension) instead. A gallery listing that, installed
  alone, surfaces no tools/commands/skills confuses end-users who expect
  every listing to do something on its own. The library remains fully
  public on npm and installable as a dep; it just isn't gallery-marketed.
  This mirrors how `@earendil-works/pi-ai` is handled — a pi-ecosystem
  dependency listed in `peerDependencies`/`dependencies`, not a gallery
  entry.

## 15. Open implementation questions (resolve before v1.0.0)

1. **`registerToggleCommand` subcommand shape.** Generated-by-default
   from the toolsets, with an optional override hook for consumer-specific
   subcommands (portal's `/web profile`, `/web cookies`)? Or fully
   consumer-supplied? Lean generated-by-default + override.
2. **Event payload typing.** Ship a `ToolsetChangedEvent` type, or keep
   payloads as `Record<string, unknown>` and let consumers narrow? Ship
   the type — it's free and prevents the bag-of-anything drift.
