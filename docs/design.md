# pi-tool-masking — Design Document

> Status: draft (pre-implementation). API is not yet frozen; this document
> is the source of truth until v1.0.0.

## 1. Purpose

This repository is the **core library** layer of a two-layer design:

1. **`pi-tool-masking` (this package)** — a pure library. It registers
   **no tools, no commands, no event handlers** with the running pi
   process. It exports plain functions (`defineToolset`,
   `setDefaultResolutionMode`, `getDefaultResolutionMode`) and the
   `TOOLSET_EVENTS` constant that *other* pi extensions call. It is not
   a pi extension in the runtime sense (no default
   `(pi: ExtensionAPI) => ...` factory); it is a library that targets
   the pi extension API, the same way a React hook library targets React
   without being a component. It does **not** register or generate any
   user-facing command (`/web`, `/api`, …) — consumers own their commands
   and call the library's primitives inside (§10).
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
   API changing — the registry + event surface (§6, §6.1) and the
   default-resolution mode (§4.5) already expose what such a manager
   needs, including durable focus.

## 3. Non-goals

- **Not** a framework. The public API is a handful of exports — two
  functions (`defineToolset`, `setDefaultResolutionMode`), one getter
  (`getDefaultResolutionMode`), the `TOOLSET_EVENTS` constant, and their
  accompanying types. The library does **not** register or generate any
  user-facing command — consumers own `/web`, `/api`, etc. and call the
  library's `enable`/`disable` primitives inside their own command
  handlers (§10). The moment `ToolsetSpec` sprouts fields only one
  consumer uses, this has become the wrong abstraction.
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
- a `persistKey` (the new write key, e.g. `toolset-state:portal.web`)
  for branch-aware state memory, plus optional `legacyPersistKeys` for
  one-cycle migration reads from pre-extraction entry names
- an optional `configKey` + `defaultEnabled` for fresh-session config-file
  defaults
- an optional `masked` flag (addressability — see §4.2)
- an optional `requires` array (dependency — see §4.4)
- an optional `emitMemberEvents` flag (see §6)

The library does **not** own status-bar glyphs. A toolset has no `slot` /
`glyphs` fields. The side-effect of updating a status-bar slot belongs to
whoever owns that slot, driven by `pi.events` (see §9). This keeps the
library out of UI presentation and makes portal's `browser` slot work
exactly like search's `search` slot — both listen for their own
toolset's `changed`/`restored` events and render their own glyph.

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

### 4.4 Toolset dependencies (`requires`)

A toolset may declare `requires: string[]` — the ids of other toolsets
that must be enabled for it to be enabled. This is a **generic
dependency primitive**, not consumer vocabulary: "A requires B" says
nothing about browsing, learning, or APIs. It exists because portal and
host share the identical pattern (an extended toolset that is
meaningless without its base), and the invariant must hold regardless of
*who* triggers the toggle — the owning extension's command handler, the
downstream manager (§13), or a future tag operation.

Rules the library enforces (one copy, one test — the peer-composition
invariant's sibling, §9):

- `enable(A)` where `A.requires = [B, C]` → transitively `enable(B)`,
  `enable(C)` before enabling A. Cycles are a spec error, detected lazily
  at first graph resolution (not at `defineToolset` time — `requires` may
  forward-reference a toolset registered later by another extension, so
  the full graph is not available at any single `defineToolset` call).
- `disable(B)` → cascade `disable` to every registered toolset whose
  `requires` contains `B` (and transitively, their dependents).

This is what prevents the incoherent state `portal.learn.enabled = true`
while `portal.web.enabled = false`: `portal.learn` declares
`requires: ["portal.web"]`, so enabling learn pulls web on and disabling
web pushes learn off — no matter which surface actuates it. The
consumer's command handler no longer re-implements the composition at
every call site (see §10).

### 4.5 Default-resolution mode (exclusion vs inclusion)

The library's per-toolset persistence record (`{ enabled }`, §7) is, by
default, an **exclusion record**: a toolset with no branch entry falls
back to `spec.defaultEnabled` (typically on). This matches today's
portal/host behavior — tools are on unless explicitly turned off.

An **inclusion mode** flips only the fallback for *unknown* toolsets:
the per-toolset record shape is unchanged, but a toolset with no branch
entry defaults **off** instead of to `spec.defaultEnabled`. The
mechanism is a default-resolution policy, not a new record type — same
`{ enabled }` entries, one mode bit on the restore path the library
already owns (§7.1).

```
Exclusion mode (default):  no entry → spec.defaultEnabled   → unknowns ON
Inclusion mode (focus):     no entry → false                 → unknowns OFF
```

This is the durability mechanism for focus (§13.2): when a new
extension is installed and registers toolsets E, F, G after a focus
snapshot was taken, E/F/G have no branch entry. Under exclusion mode
they would default on and silently break focus; under inclusion mode
they default off and focus survives the installation. No event-watching,
no manager re-apply loop — the library holds the line at restore time.

Scope and defaults:

- The mode is **library-level** (one setting for the whole registry),
  not per-toolset. It governs the fallback for toolsets without a
  branch entry; toolsets *with* an entry always restore that entry's
  `enabled` regardless of mode.
- It composes with `requires` (§4.4): a new toolset E (no entry) under
  inclusion mode stays off even if its `requires` target is on — focus
  means "only what I explicitly enabled." E's `requires` only fires
  when E is actuated, and it isn't.
- Portal and host never set inclusion mode — they run in the default
  exclusion mode for their entire lifecycle. The mode exists for the
  manager's focus feature. It is built into the library now (along with
  the persist schema, §7) so the v1 storage shape and API are stable
  before any consumer ships against them; the manager later flips the
  mode and supplies the focus *intent* (which toolsets are in the
  allowlist). See §13.2.

The mode is not consumer vocabulary baked into the core — it is a policy
on default resolution, which is already a library concern (§7, §8). One
bit, one place, one test.

## 5. Public API (proposed, pre-freeze)

The entire surface — keep it this small. This is a **library API**
(imported by other extensions), not an extension factory.

```ts
// index.ts — plain exports, no default factory

export interface ToolsetSpec {
  /** Stable id, e.g. "portal.web". Used in persist keys and event payloads. */
  id: string;
  /** Human-readable name for the group as a unit, e.g. "Web Browsing".
   *  Reuses the tool-metadata field name verbatim — `pi.registerTool()`
   *  already takes `label` on individual tools, and `pi.getAllTools()`
   *  returns it. Same field, same contract, so a presenter renders a
   *  toolset row and a tool row with identical field logic. No new field
   *  name is introduced.
   *
   *  The *value* is a net-new string the consumer authors for the group:
   *  no union of member `label`s synthesizes a useful group name. The
   *  library treats it as opaque pass-through — it never reads, branches
   *  on, or renders it; it stores it on the registry for presenters
   *  (picker rows, command help, the downstream manager §13).
   *
   *  Optional — presenters fall back to `id` (trimmed at the last `.` for
   *  namespaced ids: `portal.web` → `web`) when absent. */
  label?: string;
  /** One-line description of what enabling the group does, e.g.
   *  "Interactive browser automation: navigate, click, type, inspect."
   *  Reuses the tool-metadata field name verbatim — same field individual
   *  tools expose via `pi.registerTool()` / `pi.getAllTools()`.
   *
   *  The *value* is authored for the group (not derived from member
   *  `description`s); the library treats it as opaque pass-through for
   *  presenters (picker detail, command help). Optional — presenters
   *  omit the detail line when absent. */
  description?: string;
  /** Tool names this toolset governs. */
  names: Set<string>;
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
  /** Dependency: ids of toolsets that must be enabled for this one to be
   *  enabled. `enable` transitively enables them; `disable` of a required
   *  toolset cascades `disable` to every toolset that `requires` it. This
   *  is the peer-composition invariant's sibling — one copy, one test
   *  (§4.4, §9). Generic: "A requires B", never consumer vocabulary. */
  requires?: string[];
  /** When true, a group toggle additionally emits one `changed` event per
   *  member tool (with the member name in `event.member`), for per-tool UIs
   *  (the downstream picker, §13). The group-level event always fires.
   *  Default false: one group-level event per toggle. */
  emitMemberEvents?: boolean;
}

// Presenters (the manager §13, a future /toolsets command) read
// `label`/`description` from the registry. Fallback when absent:
//   label  → id trimmed at last '.' ("portal.web" → "web")
//   description → omit the detail line
// The library never renders these; it only stores and exposes them.

export interface Toolset {
  enable(pi: ExtensionAPI): void;
  disable(pi: ExtensionAPI): void;
  isEnabled(pi: ExtensionAPI): boolean;
}

export function defineToolset(pi: ExtensionAPI, spec: ToolsetSpec): Toolset;

/** Default-resolution mode for toolsets with no branch entry (§4.5).
 *  - "exclusion" (default): no entry → spec.defaultEnabled (unknowns ON)
 *  - "inclusion":           no entry → false            (unknowns OFF)
 *  Library-level: one setting for the whole registry. Portal/host stay
 *  in exclusion mode; the manager sets inclusion mode for focus (§13.2). */
export type DefaultResolutionMode = "exclusion" | "inclusion";

export function setDefaultResolutionMode(
  pi: ExtensionAPI,
  mode: DefaultResolutionMode,
): void;

export function getDefaultResolutionMode(pi: ExtensionAPI): DefaultResolutionMode;
```

There is **no `registerToggleCommand` export**. The library does not
own or generate user-facing commands — `/web`, `/api`, and any
subcommands (`on`, `off`, `learn`, `profile`, `cookies`, `status`, …)
are registered by the consuming extension via `pi.registerCommand()`
and call `toolset.enable(pi)` / `toolset.disable(pi)` inside. The
peer-composition invariant (§9) and the `requires` cascade (§4.4) live
in `enable`/`disable`, so a ~10-line command handler gets the full
invariant for free without a library-side command abstraction. An
auto-generated command surface with an override hook was considered and
rejected: its first real consumer (portal's `/web`) overrides roughly
half the generated subcommands, so the "default" is dead weight and the
override hook costs more than the dispatch it saves (see §15).

## 6. Change notification: `pi.events`, not custom hooks

The package emits typed events on every toolset status change. Consumers
listen with `pi.events.on(...)`. There are **no per-tool callback hooks** —
a custom hook system would reinvent the documented cross-extension bus
with worse decoupling.

```ts
export interface ToolsetChangedEvent {
  /** Toolset id (e.g. "portal.web"). Always set. */
  id: string;
  enabled: boolean;
  /** Present only when emitMemberEvents is on and this is a per-member fanout
   *  event: the member tool's name. Absent on the group-level event. Consumers
   *  that only care about group state check `if (!event.member)` or ignore
   *  member events entirely — a listener for `id === "portal.web"` still
   *  receives the group-level event regardless of emitMemberEvents. */
  member?: string;
}

export const TOOLSET_EVENTS = {
  /** Emitted on enable/disable. Always one group-level event (id = toolset id).
   *  When emitMemberEvents is set, additionally one event per member tool with
   *  that tool's name in `member` (and the same group `id`). */
  changed: "toolset:changed",    // ToolsetChangedEvent
  /** Emitted after session_start / session_tree restore re-applies state. */
  restored: "toolset:restored",  // ToolsetChangedEvent
} as const;
```

This replaces portal's current `setSearchSlot()` reach into search's
status slot: portal emits nothing, search listens for `restored`/`changed`
for the `portal.web` toolset and owns its own `search` glyph. Portal no
longer references search.

> **`ctx` capture pattern.** `pi.events` listeners receive only `(data)`,
> not `ctx`, so a listener that needs to touch the UI (e.g.
> `ctx.ui.setStatus`) captures `ctx` from its own `session_start` handler
> into a module variable and reuses `ctx.ui` in the bus listener.
> `ctx.ui` is stable across the session; only `ctx.sessionManager` is
> stale-sensitive (not used by glyph listeners). This is the documented
> pattern — see pi's `examples/extensions/event-bus.ts`.

`emitMemberEvents` is the one forward-compat knob for the downstream
picker (§13): when on, a group toggle additionally fans out to one
`changed` event per member tool (with the member name in `event.member`)
so a per-tool UI updates without the manager re-deriving membership. The
group-level event always fires regardless — consumers keyed to a toolset
id (search listening for `portal.web`) are unaffected by the flag.
Default `false` keeps today's one-event-per-group behavior.

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
`masked`, `requires`) plus the `Toolset` object, keyed by `spec.id`. The
manager extension queries it and calls `toolset.enable(pi)` /
`disable(pi)` with its **own** `pi` — all extensions in a pi session
share the same underlying runtime, so `setActiveTools` / `appendEntry`
issued through the manager's `pi` act on the same session state the
registering extension would touch. Passing `pi` explicitly to each call
(rather than capturing it at `defineToolset` time) keeps the registry
from holding session-bound references that could go stale across
`/reload` / `/resume`.

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
`session_tree`. The persist schema is stable from v1: the same `{ enabled }`
record is read the same way under both default-resolution modes (§4.5) —
the mode only changes the fallback for a toolset with *no* branch entry,
never the shape of an entry that exists.

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

Each toolset restores from its own `toolset-state:<id>` entry. A toolset
*with* an entry always restores that entry's `enabled`, regardless of the
default-resolution mode (§4.5) — the mode only affects toolsets with *no*
entry. Portal's restore does not depend on host's `session_start` handler
firing first, and vice versa. The only cross-*extension* observer is
search (for its slot glyph), and it reacts to the `restored` event
rather than to handler ordering — which also eliminates the current
portal-`session_start`-vs-search-`session_start` race. (Portal also
listens for its own toolset events to render its `browser` glyph, but
that is a same-extension observer, not a cross-extension one.)

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
disable(pi: ExtensionAPI): void {
  const current = pi.getActiveTools();        // NOT getAllTools()
  pi.setActiveTools(current.filter((n) => !this.spec.names.has(n)));
  // then cascade disable to dependents (§4.4)
}
```

`enable()` is additive: `[...new Set([...current, ...registered])]`,
where `registered` is `spec.names` filtered to tools actually present in
`pi.getAllTools()` (see §4 — a toolset tolerates unregistered names).
`enable()` also transitively `enable()`s every toolset in `spec.requires`
before applying its own change (§4.4).

`disable()` filters `spec.names` out of the *currently active* set (the
rule below), then cascades `disable()` to every registered toolset whose
`requires` contains this one's id (§4.4).

The library does **not** call `ctx.ui.setStatus`. `enable`/`disable`
take only `pi` (for `setActiveTools` + `appendEntry`), not `ctx`. Status-
bar glyphs are a side-effect owned by whoever owns the slot: the consumer
listens for `TOOLSET_EVENTS.changed`/`restored` and renders its own glyph.
This makes portal's `browser` slot work exactly like search's `search`
slot — both listen, neither is reached into. See §10.

**Why `getActiveTools()` and not `getAllTools()` on disable:** using
`getAllTools()` would re-activate every registered tool outside this
toolset's set, silently re-enabling tools another toggle (e.g. host's
`/api off`) has already disabled. This is the bug class the extraction
exists to kill. One copy, one test, one place to break it.

The canonical tests:

- **Peer composition:** two toolsets A and B, both enabled; disable A;
  assert B's tools remain active and A's are gone. Disable B; assert A's
  tools are *not* re-activated.
- **Dependency cascade:** toolset L declares `requires: ["B"]`; `enable(L)`
  → B is enabled too; `disable(B)` → L is disabled too; `enable(L)` while
  B is independently disabled re-enables B. No path produces
  `L.enabled && !B.enabled`.

## 10. Consumer integration (post-extraction)

### pi-lean-portal

`browser-toggle.ts` collapses from ~450 lines to roughly:

```ts
import {
  defineToolset,
  TOOLSET_EVENTS,
} from "pi-tool-masking";

const webToolset = defineToolset(pi, {
  id: "portal.web",
  names: BROWSER_TOOL_NAMES,
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
  requires: ["portal.web"],                  // learn is meaningless without web (§4.4)
});

// Portal owns the /web command outright — no library command generator.
// The requires invariant (§4.4) does the composition; the handler is
// ~10 lines of dispatch calling toolset.enable/disable.
pi.registerCommand("web", {
  description: "Enable/disable browser automation tools. Usage: /web on | off | learn | status | profile | cookies",
  handler: async (args, ctx) => {
    const cmd = args.trim().toLowerCase();
    if (cmd === "on")         { webToolset.enable(pi); learnToolset.disable(pi); }
    else if (cmd === "learn") { learnToolset.enable(pi); }        // pulls web on via requires
    else if (cmd === "off")   { webToolset.disable(pi); }         // cascades learn off via requires
    else if (cmd === "profile" || cmd.startsWith("profile "))
      await handleProfileSubcommand(cmd.slice("profile".length).trim(), ctx, pi);
    else if (cmd === "cookies" || cmd.startsWith("cookies "))
      await handleCookiesSubcommand(cmd.slice("cookies".length).trim(), ctx);
    else if (cmd === "status")
      handleStatusSubcommand(ctx, webToolset.isEnabled(pi), learnToolset.isEnabled(pi));
    else /* default */ ctx.ui.notify(/* …status help… */, "info");
  },
});

// Portal owns its own `browser` status-bar slot — listens, renders glyph.
// `pi.events` listeners receive only `(data)`, no `ctx`, so capture `ctx`
// from session_start and reuse its `.ui` (the documented pattern — see
// pi's examples/extensions/event-bus.ts). `ctx.ui` is stable across the
// session; only `ctx.sessionManager` is stale-sensitive (not used here).
let ui: ExtensionContext["ui"] | undefined;
pi.on("session_start", async (_e, ctx) => { ui = ctx.ui; });

const render = () => {
  if (!ui) return;
  const on = webToolset.isEnabled(pi), learn = learnToolset.isEnabled(pi);
  ui.setStatus("browser",
    !on ? "○ web off"
      : learn ? ui.theme.fg("success", "●") + " idle"
      : ui.theme.fg("accent", "●") + " idle");
};
pi.events.on(TOOLSET_EVENTS.changed, render);
pi.events.on(TOOLSET_EVENTS.restored, render);
```

The `/web` command handler is portal's own — `profile`, `cookies`, and
`status` (portal's status shows sessions/plugins/profiles, not just
on/off) stay where they belong, with no library override hook needed.
The `requires` invariant (§4.4) makes the composition a one-liner:

```ts
// /web on    → webToolset.enable(pi);   learnToolset.disable(pi);   // learn off, web on
// /web learn → learnToolset.enable(pi);                          // pulls web on via requires
// /web off   → webToolset.disable(pi);                           // cascades learn off via requires
```

- `SIBLING_TOOL_NAMES` / `setSearchSlot` block: **deleted**. Search's slot
  is now search's problem, driven by `pi.events`.
- `defaultProfile`: portal keeps a separate `appendEntry`.
- `restoreFromBranch` / `applyConfigDefault` / `session_start` restore
  wiring: **deleted** — owned by `defineToolset`.
- Status-bar glyph logic: portal's own `changed`/`restored` listener,
  not a library concern.

### pi-lean-host

`api-toggle.ts` collapses the same way against `host.api` /
`api-toggle-state`.

### pi-lean-search

Adds a listener (same `ctx`-capture pattern as portal above —
`pi.events` listeners get only `(data)`, so `ctx.ui` is captured from
`session_start`):

```ts
let ui: ExtensionContext["ui"] | undefined;
pi.on("session_start", async (_e, ctx) => { ui = ctx.ui; });

const render = (id: string, enabled: boolean) => {
  if (id !== "portal.web" || !ui) return;
  // search glyph reflects portal.web activation; health probe is separate
  ui.setStatus("search", enabled ? /* healthy color */ : "○ searxng");
};
pi.events.on(TOOLSET_EVENTS.changed, ({ id, enabled }) => render(id, enabled));
pi.events.on(TOOLSET_EVENTS.restored, ({ id, enabled }) => render(id, enabled));
```

Portal no longer references search at all.

## 11. Dependency & versioning strategy

- `pi-tool-masking` is a hard `dependency` of portal, host, and search —
  **not** a `peerDependency`. A hard dep is not a user choice. (Search
  depends on it for the `TOOLSET_EVENTS` constant it listens for in §10;
  portal and host depend on it for `defineToolset` and the
  `Toolset.enable`/`disable` primitives their command handlers call.)
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
  (write → restore → assert re-applied), the legacy-key read path, and
  the default-resolution mode test: register toolset A (with entry,
  enabled) and toolset B (no entry); under exclusion mode B defaults on,
  under inclusion mode B defaults off, while A's entry is honored in
  both — proving the mode flips only the fallback for unknown toolsets.
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
units → activates/deactivates each (focus additionally flips the
library's default-resolution mode to inclusion so the focus set survives
new-tool drift — see §13.2). Because a masked group's members are not
addressable units, they cannot be tagged individually — the user tags
the group, and the operation hits the group as a whole. This is the
"trade visibility with group abstraction" behavior, and it falls out of
the two-axis model with no new library machinery: `masked` is the single
source of truth, and every surface (commands, picker, tagging) respects
it.

`emitMemberEvents` (§6) is the one library-side affordance the picker may
opt into: a group toggle can additionally fan out to one `changed` event
per member (with `event.member` set) so a per-tool UI updates without the
manager re-deriving which members moved. The group-level event always
fires regardless. Default `false`; the manager sets it on toolsets it
renders per-tool.

### 13.2 "Only" / focus mode: library mechanism, manager intent

The user-facing "focus on this tag" / "only these tools" operation —
reduce the active tool set to just the named tools, and keep it that way
as new tools are installed — splits cleanly into **library mechanism**
and **manager intent**.

The **drift problem** a naive focus snapshot has: focus is a batch of
`disable()` calls producing "active = {A, B}" at a moment in time. It
records *what's off* (C, D), not a forward-going intent. When a new
extension registers toolsets E, F, G and the user `/reload`s, E/F/G have
no branch entry — under the default exclusion mode (§4.5) they fall back
to `spec.defaultEnabled` (on) and silently break focus. A manager-only
fix (re-apply the allowlist on every `session_start`) works but is racy
and re-implements default resolution at the wrong layer.

The **library mechanism** is inclusion mode (§4.5): the manager calls
`setDefaultResolutionMode(pi, "inclusion")`, and unknown toolsets
(those with no branch entry) default **off** instead of on. Same `{
enabled }` persist records, one mode bit on the restore path the library
already owns. New toolsets E/F/G default off → focus survives the
installation. No event-watching, no manager re-apply loop. The mechanism
is built into the library from v1 so the persist schema and API are
stable before any consumer ships against them; portal/host never set it
and run in exclusion mode for their entire lifecycle.

The **manager intent** is *which* toolsets are in the focus set (the
positive allowlist / tag). The manager owns that choice in its own user
config; the library holds the line against drift once the mode is set.
A focus operation is therefore:

```ts
// manager: "focus on tag X"
setDefaultResolutionMode(pi, "inclusion");      // library: unknowns stay off
const keep = new Set(tagX.toolsetIds);
for (const ts of registry.allToolsets()) {
  if (keep.has(ts.spec.id)) ts.enable(pi);      // allowlist on (requires pulls deps)
  else ts.disable(pi);                          // everything else off
}
```

There is **no `focus()` verb on `Toolset`** — focus is a composition
over `enable`/`disable` plus a mode flip, not a third activation verb.
Adding one would bake a one-consumer recipe into the core. The library's
contribution is the mode (one bit, default resolution); the manager's
is the intent (the allowlist). The split keeps the library free of tag
vocabulary while giving focus a durable foundation.

**Pi's built-in tools (`read`, `bash`, …) are preserved emergently.**
Disabling a toolset only removes *its own members* from the active set;
builtins are not members of any `defineToolset` toolset, so disabling
every non-allowlist toolset leaves builtins active. No "protected
builtin group" registration is load-bearing for focus. If the manager
later wants builtins to be a taggable/toggleable unit, it can register a
`pi.builtin` toolset then — optional, deferred, and a manager concern.

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

None open. Decisions recorded here so they don't re-surface:

1. **No library command generator.** The library does not register or
   generate any user-facing command. Consumers own `/web`, `/api`, etc.
   via `pi.registerCommand()` and call `toolset.enable(pi)` /
   `toolset.disable(pi)` inside (§10). An auto-generated command surface
   with an override hook was rejected: its first real consumer (portal's
   `/web`) overrides roughly half the generated subcommands (`profile`,
   `cookies`, a richer `status`), so the "default" is dead weight and the
   override hook costs more than the ~10 lines of trivial dispatch it
   would save. The peer-composition invariant (§9) and the `requires`
   cascade (§4.4) live in `enable`/`disable`, so a hand-written handler
   gets the full invariant for free.
2. **Typed event payloads.** Events ship a typed `ToolsetChangedEvent`
   (§6), not `Record<string, unknown>` — the type is free and prevents
   bag-of-anything drift.
