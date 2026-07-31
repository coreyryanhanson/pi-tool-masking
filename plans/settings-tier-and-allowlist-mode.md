# Plan: settings.json toolset-defaults tier + allowlist resolution mode

**Target version:** `1.2.0` (minor, unreleased). One PR, two features that
ship together. Additive in public API — no export removed or renamed, no
existing caller's behavior changed.

**Supersedes:**
[`settings-json-defaults.md`](./settings-json-defaults.md) and
[`settings-json-defaults-sprints.md`](./settings-json-defaults-sprints.md)
on `feat/stored-settings-state`. Those plans built a `toolsetResolutionMode`
settings tier that this plan **drops**, and deferred the allowlist mode
that this plan **builds now**.

**Companion (context, not scope):**
[`docs/settings-tier-and-focus-suppression-retrospective.md`](../../docs/settings-tier-and-focus-suppression-retrospective.md)
is the retrospective that diagnosed the fundamental flaw (inclusion is a
floor, not a constraint) and named idea G (allowlist array in the branch)
as the root fix. This plan implements G alongside the settings tier so
they land and test together.

**Scope:** `pi-tool-masking` only. `pi-tbox` adoption is a downstream
sprint anchored to the published `1.2.0`; it is **not** in this PR. The
pi-tbox-side design lives in
[`docs/focus-and-restore-revision.md`](../../docs/focus-and-restore-revision.md)
and will be revised to consume the surface defined here.

## Problem

Two independent gaps in `1.1.0`, plus a structural flaw in how focus uses
inclusion mode:

1. **No durable per-toolset defaults.** A toolset's fresh-session default
   is a packaged constant (`spec.defaultEnabled`). Users cannot override
   it in `settings.json` without toggling (which writes a chat-branch
   entry, session-scoped). Two consumers reinvented the same
   `settings.json` reader to inject values into `spec.defaultEnabled`
   before `defineToolset`. The library should own this.

2. **No mid-session "pull settings into live state" path.** Settings
   edits take effect on the next `/reload`. Users who `save` a config
   (or hand-edit `settings.json`) must restart to activate it. A
   `restore` primitive (tombstone the chat-branch tier so settings
   re-asserts, applied live) closes this within pi-core's append-only
   `SessionManager`.

3. **Inclusion mode cannot guarantee focus's contract.** Focus wants
   "only the allowlist is on, including against toolsets installed
   *after* focus was entered." Inclusion mode is a *floor* — a default
   for entries with no branch entry and no settings pin. It is bypassed
   by any additive entry above it (a stale `{enabled:true}` branch
   entry, a settings pin) and never applies to toolsets that don't
   exist yet (`actuateNewToolsets` bypasses the restore handler). A
   default cannot enforce a constraint. The retrospective's idea G is
   the root fix: put the finite **allowlist** in the branch as one
   array entry, and put the **suppression** (the complement) in the
   restore *handler* — handler code sees all registered toolsets
   including future installs, and applies "in array → on, else → off."
   The branch stays append-only and finite; the subtraction is
   computed, not stored.

## Design decisions

### D1 — `toolsetDefaults` settings tier, toolset-only

One reserved top-level key in `settings.json`:

```jsonc
// ~/.pi/agent/settings.json (global)
{
  "toolsetDefaults": {
    "toolset-state:pi-lean-dimension.web": { "enabled": true },
    "toolset-state:pi-lean-dimension.api": { "enabled": false }
  }
}
// .pi/settings.json (project — overrides global per entry)
{
  "toolsetDefaults": {
    "toolset-state:pi-lean-dimension.api": { "enabled": true }
  }
}
```

- Wrapper key `toolsetDefaults` (reserved). Inner key = the toolset's
  full `persistKey`. Value `{ enabled: boolean }` — same shape as the
  chat-branch entry data. One schema, two layers.
- Project overrides global **per entry** (shallow merge
  `{...global.toolsetDefaults, ...project.toolsetDefaults}`). No deep
  merge of `{enabled}` objects.
- Malformed files throw `MalformedSettingsError` before any mutator
  runs; a corrupt file is never overwritten. A malformed file
  contributes `{}` to the merge (never throws during restore — only
  mutators throw).
- The library reads both files itself, inside `doRestore`, fresh on
  each `/reload`. Downstream does nothing. (The restore handler is
  dedup'd by event-object identity across consumers; settings must be
  available no matter which consumer's handler wins the load-order
  race — only guaranteed if the library fetches them itself.)

### D2 — Drop `toolsetResolutionMode` settings tier

The `feat/stored-settings-state` branch built a parallel
`toolsetResolutionMode` settings tier so a saved focus config could
reproduce inclusion mode on a fresh session. **That tier is dropped.**

Reason: the user's concession is that focus state can be saved as
**exclusion-mode per-toolset pins** instead of an inclusion regime. A
saved focus config is `{enabled:true}` for allowlist members (and
optionally `{enabled:false}` for the rest) under `toolsetDefaults`,
reproduced on a fresh session by the existing exclusion floor. A
newly-installed toolset with no pin comes on (the leak) — accepted,
because a settings file is editable-once-and-fixed, unlike append-only
chat-branch state. **Plugin drift is more forgivable in settings than
in past chat state.**

This eliminates the restore-during-focus conflict that the retrospective
spent most of its length on: there is no mode-in-settings to re-assert,
so restore never needs to tombstone a mode entry to "let settings flow
through." Mode stays branch-persisted only.

### D3 — Add `"allowlist"` as a third resolution mode (idea G)

`DefaultResolutionMode` becomes `"exclusion" | "inclusion" | "allowlist"`.
**Additive** — `"exclusion"` and `"inclusion"` are unchanged, no caller
breaks, no deprecation. `inclusion` stays as-is for any current or future
consumer that wants a weak floor; `pi-tbox`'s focus switches to
`"allowlist"`.

The allowlist is a **finite array of toolset ids stored in the branch
mode entry**. The suppression (the complement) is **computed by the
restore handler** over all registered toolsets, not stored. This is the
retrospective's idea G: the allowance is finite and branch-persisted
(append-only-safe, superseded by a later mode entry); the subtraction
lives in handler logic, which can see toolsets that don't exist yet.

```jsonc
// branch mode entry for allowlist (customType = "toolset-resolution-mode")
{ "mode": "allowlist", "allowlist": ["my-plugin.web", "my-plugin.learn"] }
```

**Restore-handler tiering while the array is active (top-tier set-level
override):** when the last mode entry is `"allowlist"`, the handler
iterates every registered toolset and applies `in allowlist → on, else
→ off`. Per-toolset branch entries and `toolsetDefaults` settings pins
are **bypassed** while the array is authoritative. This is what makes
focus a *constraint*, not a floor — stale branch entries and settings
pins cannot leak a non-allowlist toolset on. A later mode entry (or a
null tombstone on the mode entry) supersedes the array; per-toolset
tiering resumes.

**Future-install suppression:** `actuateNewToolsets` (a `pi-tbox` call
site, downstream sprint) consults `getActiveAllowlist()` — a new library
export that reads the array from the last mode entry. A toolset
registered after focus was entered is not in the array → off. No
enumeration of the complement, ever; the array is finite, the handler
computes the rest.

**`requires` cascade:** the allowlist is expected to already include the
forward `requires` closure of its members (pi-tbox's focus resolves the
closure before calling `setDefaultResolutionMode`). The library does
**not** re-run the cascade during allowlist restore (same independence
invariant as today's per-toolset restore). A caller that passes an
allowlist missing a dependency gets that dep off — caller responsibility,
documented in the JSDoc.

### D4 — `setDefaultResolutionMode` gains an optional `allowlist` param

```ts
export function setDefaultResolutionMode(
 pi: ExtensionAPI,
 mode: DefaultResolutionMode,
 allowlist?: string[],
): void;
```

- `mode === "allowlist"` → `allowlist` is required and must be a non-empty
  array of toolset ids. Validates: throws if absent/empty. Does **not**
  validate that ids are registered (forward references are legal — a
  toolset may register after the mode is set; that's the point).
- `mode === "exclusion" | "inclusion"` → `allowlist` ignored (and
  rejected if non-null? no — ignored, to keep the signature simple and
  the existing two-arg call sites unchanged).
- Persists `{ mode, allowlist }` in the mode entry. Existing
  exclusion/inclusion entries persist `{ mode }` only (unchanged shape).

### D5 — `getActiveAllowlist()` reads the array from the branch

```ts
export function getActiveAllowlist(): string[] | undefined;
```

Reads the last `MODE_PERSIST_KEY` branch entry. If its mode is
`"allowlist"`, returns the `allowlist` array (or `[]` if the field is
absent/malformed — defensive). Otherwise returns `undefined`. This is
the single source of truth for the active allowlist — `pi-tbox`'s
`actuateNewToolsets` and any other call site read it here, not from a
pi-tbox-private copy, so the branch mode entry and the live suppression
cannot drift apart.

### D6 — Null-tombstone restore for toolset entries

`doRestore` drops the `b.data != null` filter on the per-toolset
`persistEntries` lookup. A `null` (or absent `enabled`) last entry means
"cleared → fall through to settings → mode floor → packaged." This lets
`/tbox defaults restore` (downstream) tombstone the chat-branch tier so
settings re-asserts, within append-only. Tombstones are not sticky — a
later manual toggle appends after the tombstone and supersedes it.

The mode entry filter gets the same null-tombstone-aware pattern: read
the last mode entry regardless of `data`, check `data?.mode` validity,
fall through to `"exclusion"` if absent/tombstoned. **No settings
fallback for mode** (there is no mode settings tier). Mode resolution is
`branchMode ?? "exclusion"`.

### D7 — Tombstone helpers (toolset entries only)

```ts
export function clearToolsetEntry(pi: ExtensionAPI, persistKey: string): void;
export function clearAllToolsetEntries(pi: ExtensionAPI): void;
```

Owns the tombstone-write convention: append `null` only if the last
entry for that key is not already cleared. Dedup'd — consecutive
restores don't stack tombstones. The library owns branch-read semantics,
so it owns the tombstone-write convention.

**No `clearModeEntry` / `applyResolutionMode`.** The branch's mode
tombstone helpers are dropped. Mode is never tombstoned — it is always
set by appending a new mode entry (`setDefaultResolutionMode`), which
supersedes any prior allowlist. There is no settings-mode to "flow
through" a tombstone, so tombstoning the mode buys nothing that
appending `exclusion` doesn't. Restore (downstream) that wants to lift
focus calls `setDefaultResolutionMode(pi, "exclusion")` — the new
exclusion entry is the last mode entry, the allowlist is supersended,
per-toolset tombstones make settings re-assert. Focus lifted, settings
live. Coherent without a mode tombstone.

### D8 — `applyToolsetEnabled` apply-without-persist helper

```ts
export function applyToolsetEnabled(
 pi: ExtensionAPI,
 spec: ToolsetSpec,
 enabled: boolean,
): void;
```

One-line wrapper over the private `_applyRestoreToolset(spec, pi, enabled,
false)` — applies state via `setActiveTools` + emits `TOOLSET_EVENTS.changed`,
**no `appendEntry`**. For `/tbox defaults restore`'s live-apply path
(downstream). `_applyRestoreToolset` stays private for `doRestore`'s own
use (which emits `restored` vs `changed` via the `isPersistedEntry`
flag). The wrapper hides that internal flag behind a clean public name.

## How G dissolves the save/restore-during-focus refusals

The prior oracle ruling refused `save` and `restore` during focus because
in the inclusion/A+B world they create mode mismatches. **With G, both
become coherent and are allowed** — a cleaner result:

- **`save` during focus** (downstream): writes the current live on/off
  state as exclusion pins under `toolsetDefaults`. Under allowlist mode,
  live state *is* "allowlist members on, others off" — so the pins
  capture the focus selection exactly. The mode is not saved (no mode
  settings tier, by D2). On a fresh session the exclusion pins reproduce
  the selection (with the accepted post-install leak). No refusal, no
  silent mode conversion — it's a snapshot of current state.

- **`restore` during focus** (downstream): tombstones toolset entries
  (`clearAllToolsetEntries`) + appends `exclusion` mode
  (`setDefaultResolutionMode(pi, "exclusion")`). The exclusion entry
  supersedes the allowlist; the tombstones make settings re-assert;
  `applyToolsetEnabled` pulls each toolset to its settings default. Focus
  lifts, settings go live. Coherent — "I want settings, not my focus
  selection" is a clean intent, and restore honors it.

- **`focusOff`** (downstream, Decision 1): flushes the focus-era state
  to per-toolset entries (`{enabled:true}` for allowlist members,
  `{enabled:false}` for the rest) + appends `exclusion` mode. Selection
  retained in the branch under exclusion; focus lifted; no settings
  involved. Distinct from `restore` (which pulls settings) — `focusOff`
  keeps the current selection.

All three are coherent with G. No actuation-refusal guards needed on
`save`/`restore` (pi-tbox's existing focus guard still refuses *toggles*
during focus, unchanged — that's about the user not re-shaping the
allowlist mid-focus, not about settings I/O).

## `doRestore` — the three changes

Localized to `ensureRestoreHandler`'s `doRestore`:

1. **Mode resolution** (null-tombstone-aware, no settings fallback):

   ```ts
   const modeEntries = ctx.sessionManager
       .getBranch()
       .filter((b: any) => b.customType === MODE_PERSIST_KEY);
   const lastModeEntry = modeEntries[modeEntries.length - 1] as any;
   const branchMode = lastModeEntry?.data?.mode;
   const activeAllowlist = lastModeEntry?.data?.allowlist;
   const mode: DefaultResolutionMode =
       branchMode === "inclusion" || branchMode === "exclusion" || branchMode === "allowlist"
           ? branchMode
           : "exclusion";
   getModuleState().defaultResolutionMode = mode;
   ```

2. **Allowlist short-circuit** (set-level override, before the per-toolset loop):

   ```ts
   if (mode === "allowlist") {
       const allow = new Set<string>(Array.isArray(activeAllowlist) ? activeAllowlist : []);
       for (const [, entry] of registry) {
           _applyRestoreToolset(entry.spec, pi, allow.has(entry.spec.id), true);
       }
       return;
   }
   ```

   Per-toolset branch entries and settings pins are bypassed. The
   `isPersistedEntry=true` flag emits `restored` (this is a branch
   replay, not a live toggle).

3. **Per-toolset else-branch** (settings tier insertion, null-tombstone-aware):
   drop `b.data != null` from the `persistEntries` filter; in the
   else-branch, consult `readMergedToolsetDefaults()` snapshot (read
   once per pass) before the mode floor:

   ```ts
   const settingsDefaults = readMergedToolsetDefaults(); // once per pass
   // ... per toolset:
   const lastEntry = persistEntries[persistEntries.length - 1];
   const enabled = (lastEntry as any)?.data?.enabled;
   if (typeof enabled === "boolean") {
       _applyRestoreToolset(spec, pi, enabled, true);
   } else {
       const settingsEnabled = settingsDefaults[spec.persistKey];
       const fallback = spec.defaultEnabled ?? true;
       const resolved =
           typeof settingsEnabled === "boolean"
               ? settingsEnabled
               : mode === "inclusion" ? false : fallback;
       _applyRestoreToolset(spec, pi, resolved, false);
   }
   ```

   The re-read-per-toolset branch pattern (for companion-mirror visibility)
   is unchanged — settings is read once (stable mid-restore), the branch
   is re-read per toolset.

## Public API surface — final

### New exports (10)

| Export | Purpose |
|---|---|
| `readMergedToolsetDefaults()` | Merged settings reader (global + project, shallow per-entry merge). |
| `readToolsetDefaults(scope)` | Per-scope reader (for `show` attribution). |
| `writeToolsetDefaults(entries, scope)` | Settings writer (for `save`). Preserves every non-`toolsetDefaults` key. |
| `clearToolsetDefaults(scope)` | Settings clearer (for `clear`). Returns `true` if the block existed. |
| `getEffectiveDefault(spec, snapshot?)` | Tier-2 (settings) then tier-3 (packaged) resolver. Ignores mode — caller checks allowlist mode separately. |
| `clearToolsetEntry(pi, persistKey)` | Tombstone one toolset branch entry (dedup'd). |
| `clearAllToolsetEntries(pi)` | Tombstone all registered toolset branch entries. |
| `applyToolsetEnabled(pi, spec, enabled)` | Apply state without persisting, emit `changed`. Wrapper over `_applyRestoreToolset(..., false)`. |
| `getActiveAllowlist()` | Read the allowlist array from the last mode entry; `undefined` if mode isn't `allowlist`. |
| `MalformedSettingsError` | Error class thrown by mutators on a corrupt settings file. |

### Changed exports (1)

| Export | Change |
|---|---|
| `setDefaultResolutionMode(pi, mode, allowlist?)` | Optional `allowlist` param. Required when `mode === "allowlist"`. |

### Internal/test exports (4, `@internal`)

| Export | Purpose |
|---|---|
| `parseToolsetDefaults(json)` | Unit-testable parse helper. |
| `mergeToolsetDefaults(global, project)` | Unit-testable merge helper. |
| `setSettingsOverrideForTests(defaults)` | Test seam for the reader. |
| `setSettingsWriterOverrideForTests(state)` | Test seam for the writer. |

### Unchanged from `main`

`defineToolset`, `getDefaultResolutionMode`, `getRegisteredToolsets`,
`TOOLSET_EVENTS`, `ToolsetSpec` / `Toolset` / `ToolsetChangedEvent` /
`RegistryEntry` types, and all private cascade/apply internals
(`_applyEnable`, `_applyDisable`, `_enableToolset`, `_disableDependents`,
`_applyRestoreToolset`, `_emitToolsetEvents`, `ToolsetImpl`).

### Dropped from `feat/stored-settings-state` (the mode settings tier)

`clearModeEntry`, `applyResolutionMode`, `readMergedToolsetResolutionMode`,
`readToolsetResolutionMode`, `writeToolsetResolutionMode`,
`clearToolsetResolutionMode`, `parseToolsetResolutionMode`,
`setSettingsModeOverrideForTests`, `setSettingsModeWriterOverrideForTests`.
~200 lines of index.ts + ~10 test cases. The mode tier was the source of
the fundamental flaw; dropping it is the point.

## What is clean

- **Focus is a constraint, not a floor.** The allowlist array is a
  top-tier set-level override while active. Stale branch entries, settings
  pins, and future-installed toolsets all lose to it. The retrospective's
  fundamental flaw is resolved at the root, within append-only.
- **Save and restore during focus are coherent.** G makes both work
  without refusals or silent conversions (see above).
- **Settings tier is sound and independently useful.** `toolsetDefaults`
  solves the real "users can't durably override defaults" problem
  regardless of focus.
- **Backward compat preserved.** No export removed. `inclusion` stays.
  No existing caller appends an allowlist entry, so the new top tier is a
  no-op today. No settings file carries `toolsetDefaults` yet, so the
  settings tier is a no-op for existing installs.
- **Library is not focus-aware.** The library owns a *general*
  allowlist-suppressed-mode primitive. It doesn't know about "focus" —
  that's a pi-tbox concept. Any consumer that wants "only this set is on,
  resilient to new installs" uses `"allowlist"`. The name is generic.

## What is not clean (accepted limitations)

- **Saved focus configs leak post-install.** A `save` during focus
  writes exclusion pins. A toolset installed *after* the save has no pin,
  hits the exclusion floor (`defaultEnabled ?? true`), comes on. Accepted
  by the user's concession — a settings edit fixes it once. The
  alternative (persisting the allowlist to a settings key so fresh
  sessions reconstruct the array) is **deferred**; it's the one setting
  that would make saved configs resilient too, and it's a clean future
  addition (a `toolsetAllowlist` settings key read when no branch mode
  entry wins). Not in this release.
- **`inclusion` mode is now dead-ish code.** No consumer will use it
  after pi-tbox switches to `allowlist`. It stays for compat (public
  export, other consumers may exist). The `doRestore` inclusion floor
  branch stays too. Cost: a few lines of dead-but-correct logic. Better
  than a breaking major-version removal.
- **Allowlist restore doesn't re-run the `requires` cascade.** Caller
  must pass the forward closure. Documented in the JSDoc. Same invariant
  as today's per-toolset restore.
- **Tombstone accumulation.** Repeated `restore`s stack null tombstones
  (small, last-wins, same cost profile as any toggle). The ceiling is
  noted; upgrade path is a pi-core "compact toolset entries" op, out of
  scope. `ponytail:` comment on `clearToolsetEntry` names the ceiling.

## Test scope

All in `__tests__/core.test.ts` against `MockPI`. `MockPI.cleanRegistry()`
in `beforeEach` (existing pattern). `setSettingsOverrideForTests({})` in
`beforeEach`, `(null)` in `afterEach` (existing pattern).

**Settings tier (toolsetDefaults):** reader (global/project merge,
per-entry override, malformed → `{}`), writer (preserves other keys,
round-trip), clearer, `getEffectiveDefault` (tier-2-then-3, mode-agnostic).
Reuse the branch's existing test ids where the behavior is unchanged;
drop the mode-tier test ids (AT/AM/CT/DT series that target
`toolsetResolutionMode`).

**Null-tombstone restore:** last toolset entry `null` → falls through to
settings → mode floor → packaged. Dedup: last entry already cleared → no
append. Companion-mirror visibility across a tombstone in the same pass.

**Allowlist mode:**

- `setDefaultResolutionMode(pi, "allowlist", ids)` persists the array;
  `getActiveAllowlist()` returns it.
- Restore under allowlist: allowlist members on, others off, **across
  all registered toolsets** — including a toolset with a stale
  `{enabled:true}` branch entry (bypassed) and one with a settings pin
  `{enabled:true}` (bypassed). The set-level override is authoritative.
- Future-install: register a toolset *after* setting allowlist mode,
  trigger `actuateNewToolsets` path (or simulate the consultation via
  `getActiveAllowlist()`) → not in array → off.
- Supersession: a later `setDefaultResolutionMode(pi, "exclusion")`
  entry → allowlist no longer active, per-toolset tiering resumes.
- Validation: `"allowlist"` without array → throws; empty array →
  throws; unregistered ids → allowed (no throw).
- `getActiveAllowlist()` returns `undefined` under exclusion/inclusion
  and under a null-tombstoned mode entry.

**Tombstone helpers:** `clearToolsetEntry` / `clearAllToolsetEntries` —
append `null` when last entry is non-null, no-op when already cleared.
`clearAllToolsetEntries` covers exactly the registered toolsets.

**`applyToolsetEnabled`:** applies state, emits `changed`, does **not**
`appendEntry`. Verify the branch is unchanged after the call.

## Extraction approach

Branch from `main` (not from `feat/stored-settings-state`). The feature
branch interleaves the mode tier with the sound parts; a clean extraction
is mechanical but error-prone if diffed. Instead, re-implement against
`main` using the branch as a reference for the `toolsetDefaults` reader/
writer/merger (which is sound and reuse-worthy) and writing the allowlist
mode + tombstone helpers fresh. This avoids carrying the mode-tier
scaffolding into history and gives a clean commit story.

**Order (each commit leaves `npm test` green):**

1. `toolsetDefaults` reader + parse/merge helpers + test seams + reader
   tests. (Port from the branch.)
2. `toolsetDefaults` writer + clearer + `MalformedSettingsError` + writer
   tests. (Port from the branch.)
3. `doRestore` else-branch settings insertion + null-tombstone toolset
   filter + `getEffectiveDefault` + tests. (Port the toolset-tier parts
   from the branch; drop the `readMergedToolsetResolutionMode` fallback.)
4. `clearToolsetEntry` / `clearAllToolsetEntries` + `applyToolsetEnabled`
   - tests. (Port toolset tombstone helpers from the branch; write
   `applyToolsetEnabled` fresh.)
5. `"allowlist"` mode: `DefaultResolutionMode` type change,
   `setDefaultResolutionMode` signature, `doRestore` allowlist
   short-circuit, `getActiveAllowlist` + tests. (New.)
6. `doRestore` mode resolution: null-tombstone-aware, `branchMode ??
   "exclusion"`, no settings fallback + tests. (Revise the branch's mode
   block; drop the settings fallback.)
7. `CHANGELOG.md` `[Unreleased]` + README API section.

## Out of scope / deferred

- **`pi-tbox` adoption** (focus patches, `focusOff` Decision 1 rewrite,
  `/tbox defaults save|restore|show|clear` dispatch, `actuateNewToolsets`
  consultation). Downstream sprint, anchored to the published `1.2.0`.
- **`toolsetAllowlist` settings key** for resilient saved configs on
  fresh sessions. Clean future addition; not needed for the concession.
- **pi-core compact-toolset-entries op** (tombstone accumulation ceiling).
- **Removing or deprecating `inclusion` mode.** Stays as-is. No
  deprecation comment needed — it's a valid mode that pi-tbox happens not
  to use after this lands.
