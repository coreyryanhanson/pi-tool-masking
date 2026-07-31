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
export that reads the array from module state (populated by `doRestore`'s
mode-resolution block from the last mode branch entry, and by
`setDefaultResolutionMode` when it writes the entry). A toolset
registered after focus was entered is not in the array → off. No
enumeration of the complement, ever; the array is finite, the handler
computes the rest.

`getActiveAllowlist()` is parameterless and reads from module state — the
same pattern as `getDefaultResolutionMode()`. This is required because the
consumer call site (`pi-tbox/src/registry.ts:actuateNewToolsets`) receives
`pi: ExtensionAPI`, and `ExtensionAPI` does **not** expose
`sessionManager` (that's on `ExtensionContext` only). A `pi`-arg signature
would not compile at the call site. Module state is the consistent home:
`doRestore` already reads the branch and sets `defaultResolutionMode`
there, so it sets the allowlist in the same block; `setDefaultResolutionMode`
sets both when it appends the mode entry. The branch is the source of
truth, module state is the live mirror — exactly as mode already works.

**Atomic two-phase restore (robust against unknown future consumers):**
the allowlist short-circuit is split into a **decide/apply phase** and a
**notify phase**. Phase 1 computes the full desired active-tools set from
the allowlist and applies it with a single `pi.setActiveTools(...)` call
— no per-toolset emit during the loop. Phase 2 then emits `restored` for
each toolset *after* state is final. This is the robust fix for the
companion-mirror interaction: a companion mirroring on
`TOOLSET_EVENTS.changed` (the standard pattern, see `core.test.ts:210`)
never fires during allowlist restore, so it cannot `appendEntry` mid-loop
and desync the final state. A companion on `restored` fires only *after*
the authoritative state is already set, so its `enable()`/`disable()` is
a live post-restore toggle — the consumer's business, not an
interleaving during restore. The library's contract stays mode-independent:
*"restore establishes the authoritative state atomically; what consumers
do in response to `restored` is their business."* This matters because
other plugins may incorporate this library with their own companion
patterns; the two-phase design is robust against both `changed`- and
`restored`-listener companions at ~5 lines' cost (one extra loop + a
single `setActiveTools`).

**Event-type contract divergence by mode (document in JSDoc):** under
exclusion/inclusion, the per-toolset restore loop emits `restored` for
toolsets with a branch entry and `changed` for default-fallback toolsets
(no branch entry). Under allowlist, phase 2 emits `restored` for **every**
registered toolset, because the whole pass is a branch replay of the
authoritative allowlist entry, not a live toggle. This is a deliberate
mode-dependent divergence in the event contract. No existing consumer is
affected today (pi-tbox doesn't use allowlist yet), but the JSDoc on
`getActiveAllowlist` / the restore handler must state it so a future
consumer expecting `changed` for fallback toolsets during restore is not
surprised when allowlist mode hands them `restored` instead.

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
  **Asymmetry with restore (intentional):** write-time rejects `[]` (an
  empty array is a likely mistake — deleting the last member and
  forgetting to switch modes — and "everything off" is a degenerate
  focus state better expressed by turning the relevant toolsets off or
  switching to inclusion mode). But `doRestore` recovers a corrupt
  missing/non-array allowlist to `[]` (fail closed), not to `exclusion`
  (fail open). Write-time validates intent; restore-time picks the safe
  recovery. See the `doRestore` mode-resolution comment for the full
  rationale.
- **Update the validation error message:** the current
  `"Must be \"exclusion\" or \"inclusion\""` must become
  `"Must be \"exclusion\", \"inclusion\", or \"allowlist\""` so the
  new mode is discoverable from the thrown error.
- `mode === "exclusion" | "inclusion"` → `allowlist` ignored (and
  rejected if non-null? no — ignored, to keep the signature simple and
  the existing two-arg call sites unchanged).
- Persists `{ mode, allowlist }` in the mode entry, and mirrors both into
  module state (`getModuleState().defaultResolutionMode` and
  `.activeAllowlist`) so `getDefaultResolutionMode()` and
  `getActiveAllowlist()` remain consistent with the branch without a
  `sessionManager` dependency. Existing exclusion/inclusion entries
  persist `{ mode }` only (unchanged shape); `.activeAllowlist` is set
  to `undefined` for non-allowlist modes.

### D5 — `getActiveAllowlist()` reads the array from module state

```ts
export function getActiveAllowlist(): string[] | undefined;
```

Parameterless, reads from `getModuleState().activeAllowlist` — same pattern
as `getDefaultResolutionMode()`. Returns the `allowlist` array when the
active mode is `"allowlist"`, otherwise `undefined`. The module state is
populated in two places, both of which already touch mode state: (a)
`doRestore`'s mode-resolution block reads the last `MODE_PERSIST_KEY` branch
entry via `ctx.sessionManager.getBranch()` and sets both
`defaultResolutionMode` and `activeAllowlist`; (b) `setDefaultResolutionMode`
sets both when it appends the mode entry. The branch remains the source of
truth; module state is the live mirror.

**Why not `pi: ExtensionAPI`:** the consumer call site receives
`pi: ExtensionAPI`, which does not expose `sessionManager` (that property is
on `ExtensionContext` only — verified against pi-core `types.d.ts`). A
`pi`-arg signature would not compile at the call site. Module state avoids
the dependency and matches the existing `getDefaultResolutionMode()` shape.
This is the single source of truth for the live allowlist — `pi-tbox`'s
`actuateNewToolsets` and any other call site read it here, not from a
pi-tbox-private copy, so the branch mode entry and the live suppression
cannot drift apart.

**`exactOptionalPropertyTypes` requirement (tsconfig):** the repo's
`tsconfig.json` enables `exactOptionalPropertyTypes: true`. The new
`ModuleState.activeAllowlist` field must be declared as
`activeAllowlist?: string[] | undefined` (with the explicit
`| undefined`), **not** bare `activeAllowlist?: string[]`. The
`doRestore` mode-resolution block and `setDefaultResolutionMode` both
assign `undefined` to it explicitly for non-allowlist modes, which is a
type error (`TS2412`) against a bare optional property under this flag.
The existing `defaultResolutionMode: DefaultResolutionMode` field is
required (not optional) and needs no change. (Verified: optional
*function parameters* like the new `allowlist?` on
`setDefaultResolutionMode` and `snapshot?` on `getEffectiveDefault` are
**not** affected by `exactOptionalPropertyTypes` — only object-type
properties are — so those bare `?: T` param forms compile fine and stay
as written.)

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

This null-tombstone awareness is **purely defensive**: D7 ships no
`clearModeEntry`, so no public API tombstones the mode entry — the
tombstoned-mode path is unreachable today. The guard costs one
optional-chain check (`data?.mode`) and keeps mode resolution robust if
a future API adds mode tombstoning. Dropped only if that API is
explicitly rejected.

### D7 — Tombstone helpers (toolset entries only)

```ts
export function clearToolsetEntry(pi: ExtensionAPI, persistKey: string): void;
export function clearAllToolsetEntries(pi: ExtensionAPI): void;
```

Owns the tombstone-write convention: append `null` only if the key has
a prior entry **and** its last entry is not already cleared. A toolset
that was never toggled has no branch entry — appending `null` would
create a redundant tombstone for a key with no prior state, so skip
it. Dedup'd — consecutive restores don't stack
tombstones, and never-toggled toolsets get no tombstone at all. The
library owns branch-read semantics, so it owns the tombstone-write
convention.

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
   const branchAllowlist = lastModeEntry?.data?.allowlist;
   // Fail closed: a branch entry claiming "allowlist" with no usable
   // array is corruption (write-time validation prevents it, but branch
   // files are hand-editable). Recover to an EMPTY allowlist, not to
   // "exclusion". Two reasons:
   //   (1) Respect the branch's mode claim. mode="allowlist" is a state
   //       someone chose; silently rewriting it to "exclusion" (which
   //       means "everything on" under default fallback) is a mode
   //       change nobody made and fails OPEN — the wrong default for a
   //       masking library. Empty allowlist = "nothing is on", the
   //       safe recovery.
   //   (2) Keep mode + array consistent. mode=allowlist with
   //       activeAllowlist=undefined is contradictory
   //       (getDefaultResolutionMode() === "allowlist" while
   //       getActiveAllowlist() === undefined). mode=allowlist with
   //       activeAllowlist=[] is consistent and means "no member is
   //       allowed on" — the same semantic as a populated allowlist
   //       whose members are all unregistered.
   // This mirrors the asymmetry with D4: D4 rejects an empty array at
   // WRITE time (an empty array is a likely mistake — e.g. deleting the
   // last member and forgetting to switch modes), but restore recovers
   // a missing/non-array to [] rather than failing open. Write-time
   // validates intent; restore-time picks the safe recovery.
   const allowArr = Array.isArray(branchAllowlist) ? branchAllowlist : [];
   const mode: DefaultResolutionMode =
       branchMode === "inclusion" || branchMode === "exclusion"
           ? branchMode
           : branchMode === "allowlist"
               ? "allowlist"
               : "exclusion";
   const ms = getModuleState();
   ms.defaultResolutionMode = mode;
   // Mirror the allowlist into module state so `getActiveAllowlist()`
   // (parameterless, no `pi`/`sessionManager` access) can read it. The
   // branch is the source of truth; module state is the live mirror —
   // same pattern as `defaultResolutionMode` above. `setDefaultResolutionMode`
   // sets this same field when it appends the entry.
   ms.activeAllowlist =
       mode === "allowlist" ? allowArr : undefined;
   ```

2. **Allowlist short-circuit** (atomic two-phase, set-level override,
   before the per-toolset loop):

   ```ts
   if (mode === "allowlist") {
       const allow = new Set<string>(Array.isArray(branchAllowlist) ? branchAllowlist : []);
       const registered = new Set(pi.getAllTools().map((t) => t.name));

       // Phase 1: compute the desired active-tools set as a DELTA from
       // the current set, and apply it in ONE `setActiveTools` call.
       // The library only governs tools that belong to registered
       // toolsets; anything outside that set is not its concern and is
       // left untouched. `setActiveTools` is a full replacement, so we
       // must preserve tools not owned by any registered toolset rather
       // than rebuild the set from only allowlist members. The suppress
       // set is the complement of the allowlist *among registered
       // toolset tools only*; everything else in the current set is
       // kept as-is. This mirrors the existing per-toolset restore
       // (`_applyRestoreToolset` only adds/removes `spec.names`),
       // applied set-wide. No per-toolset emit during this loop —
       // companions on `changed` (the standard mirror pattern) cannot
       // fire mid-restore and `appendEntry` against an in-progress
       // state.
       const current = new Set(pi.getActiveTools());
       const suppress = new Set<string>();
       for (const [, entry] of registry) {
           if (!allow.has(entry.spec.id)) {
               for (const n of entry.spec.names) suppress.add(n);
           }
       }
       const desired = new Set<string>();
       for (const n of current) {
           if (!suppress.has(n)) desired.add(n); // keep non-toolset tools
       }
       for (const [, entry] of registry) {
           if (allow.has(entry.spec.id)) {
               for (const n of entry.spec.names) desired.add(n);
           }
       }
       // The `registered` filter is partially redundant: names carried over
       // from `current` are already active (hence registered), so the filter
       // only matters for spec names that aren't registered tools. Kept for
       // parity with `_applyRestoreToolset`'s per-name filtering and as a
       // belt-and-suspenders guard against a stale registry entry whose
       // `names` reference a tool that has since been removed.
       pi.setActiveTools([...desired].filter((n) => registered.has(n)));

       // Phase 2: notify AFTER state is final. Emit `restored` (this is
       // a branch replay, not a live toggle). A companion on `restored`
       // fires against the already-authoritative state, so its toggle is
       // a live post-restore action on the consumer's side of the
       // boundary — not an interleaving during restore.
       for (const [, entry] of registry) {
           _emitToolsetEvents(
               entry.spec,
               pi,
               TOOLSET_EVENTS.restored,
               allow.has(entry.spec.id),
           );
       }
       return;
   }
   ```

   Per-toolset branch entries and settings pins are bypassed. The
   `isPersistedEntry=true` equivalent (`restored`) is emitted in phase 2.
   This two-phase split is the robust fix for the companion-mirror
   interaction: it removes
   the per-toolset emit-during-loop that a companion mirror could react
   to with a synchronous `appendEntry`, desyncing the final state. See
   D3's "Atomic two-phase restore" note for the contract and rationale.

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
| `getActiveAllowlist()` | Read the live allowlist array from module state (mirrored from the last mode branch entry by `doRestore` and `setDefaultResolutionMode`); `undefined` if mode isn't `allowlist`. Parameterless — matches `getDefaultResolutionMode()`. |
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
- **Settings file path coupling (N2).** The reader/writer hardcode
  `~/.pi/agent/settings.json` (global) and `.pi/settings.json` (project)
  via `os.homedir()` + `path.join`. If pi-core moves its settings paths or
  format, the library breaks with no configuration knob. Accepted ceiling;
  `ponytail:` comment on `readMergedToolsetDefaults` names the coupling
  and the upgrade path (a pi-core settings-path registry, if one ever
  appears). Rationale for reading files directly (load-order race safety)
  is in D1.
- **Concurrent file access in `writeToolsetDefaults` (N3).** The writer is
  read-modify-write (read existing file, merge `toolsetDefaults`, write
  back preserving every other key). Two writers racing could lose a key.
  Acceptable for rarely-written settings files; `ponytail:` comment on
  `writeToolsetDefaults` names the ceiling (per-file lock or atomic
  write-rename if settings ever become contended).

## Test scope

All in `__tests__/core.test.ts` against `MockPI`. `MockPI.cleanRegistry()`
in `beforeEach` (existing pattern). `setSettingsOverrideForTests({})` in
`beforeEach`, `(null)` in `afterEach` (existing pattern).

**Settings tier (toolsetDefaults):** reader (global/project merge,
per-entry override, malformed → `{}`), writer (preserves other keys,
round-trip), clearer, `getEffectiveDefault` (tier-2-then-3, mode-agnostic).
Reuse the branch's existing test ids where the behavior is unchanged.
(The AT/AM/CT/DT mode-tier test ids from `feat/stored-settings-state` do
not exist on `main` — this plan branches from `main` — so there is nothing
to drop; the earlier "drop the mode-tier test ids" wording referred to a
branch that is no longer the base.)

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
- **Non-toolset tools preserved (B1 regression guard):** seed
  `pi.getActiveTools()` with a name not owned by any registered
  toolset. After allowlist restore, assert that name is **still
  active** — `setActiveTools` is a full replacement, so the
  short-circuit must compute a delta from current and leave tools it
  does not govern untouched, not rebuild the set from only allowlist
  members. The library manages registered-toolset tools only.
- Future-install: register a toolset *after* setting allowlist mode,
  trigger `actuateNewToolsets` path (or simulate the consultation via
  `getActiveAllowlist()`) → not in array → off.
- Supersession: a later `setDefaultResolutionMode(pi, "exclusion")`
  entry → allowlist no longer active, per-toolset tiering resumes.
- Validation: `"allowlist"` without array → throws; empty array →
  throws; unregistered ids → allowed (no throw).
- **Restore fail-closed recovery:** seed a branch mode entry with
  `data.mode === "allowlist"` but `data.allowlist` missing (or not an
  array). Fire `session_start`. Assert: `getDefaultResolutionMode()`
  returns `"allowlist"` (mode claim respected, not silently rewritten
  to `"exclusion"`); `getActiveAllowlist()` returns `[]` (consistent,
  not `undefined`); every registered toolset is **off** (fail closed,
  not fail open). This is the asymmetric counterpart to the write-time
  `[]` rejection: write rejects an empty array as a likely mistake,
  restore recovers a corrupt/missing array to `[]` as the safe
  recovery. Verify the non-allowlist-malformed case (e.g. `mode:`
  absent or tombstoned) still falls through to `"exclusion"`.
- **Error-message update:** the existing "throws for
  invalid mode" test at `core.test.ts:1022-1026` asserts the old exact
  string `"Must be \"exclusion\" or \"inclusion\""`. Update it to
  expect the new message including `"allowlist"` (per D4).
- `getActiveAllowlist()` returns `undefined` under exclusion/inclusion
  and under a null-tombstoned mode entry.
- **Companion-mirror safety during allowlist restore:** register a
  base + companion where the companion mirrors `base` on
  `TOOLSET_EVENTS.changed` (the pattern from `core.test.ts:210`). Set
  allowlist mode with `base` in the array, `comp` NOT in the array. Fire
  `session_start`. Assert: (a) `base` is on, `comp` is off; (b) the
  companion's `changed` handler did NOT fire during restore (no
  mid-loop `appendEntry` for `comp`) — i.e. `comp`'s branch has no
  `{enabled:true}` entry written by the mirror. The two-phase restore
  establishes the authoritative state before any notification, so a
  `changed`-mirror cannot desync it. (A companion on `restored` that
  re-enables `comp` is a live post-restore toggle — out of the
  library's scope, consumer's business.)

**Tombstone helpers:** `clearToolsetEntry` / `clearAllToolsetEntries` —
append `null` when last entry is non-null, no-op when already cleared,
no-op when the key has no prior entry (no redundant tombstone for a
never-toggled toolset, per D7). `clearAllToolsetEntries` covers
exactly the registered toolsets.

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

1. **Fix pre-existing `tsc --noEmit` failure on `main` (N4) — first, to
   give a clean typecheck baseline for the feature work:**
   `__tests__/mock-pi.ts` is missing `scopedModels` / `isProjectTrusted`
   from `ExtensionContext`, which blocks `prepublishOnly`
   (`npm test && npx tsc --noEmit`) and thus the 1.2.0 publish, *and*
   leaves `tsc --noEmit` red on `main` before any feature lands. Add the
   missing stub fields to `MockPI`. Unrelated to this plan's features but
   required to ship the release. Ordered first (not last) because this
   plan adds new TS surface (`ModuleState.activeAllowlist` with the
   `exactOptionalPropertyTypes` `| undefined` trap, new optional params,
   10 new exports) — the exact kind of bug that flag catches (TS2412 on
   bare optional properties) is what steps 2–8 are shipping. A red
   baseline would mix pre-existing TS2739 with your own errors on every
   `npm run typecheck`, so you'd either miss a TS2412 or waste time
   disentangling. AGENTS.md tells you to run typecheck yourself before
   shipping; a clean baseline makes that actually useful. Smallest,
   most independent commit — ideal commit 1. (`npm test` / vitest never
   runs `tsc --noEmit`, so this commit is green on `npm test` too.)
2. `toolsetDefaults` reader + parse/merge helpers + test seams + reader
   tests. (Port from the branch.)
3. `toolsetDefaults` writer + clearer + `MalformedSettingsError` + writer
   tests. (Port from the branch.)
4. `doRestore` else-branch settings insertion + null-tombstone toolset
   filter + `getEffectiveDefault` + tests. (Port the toolset-tier parts
   from the branch; drop the `readMergedToolsetResolutionMode` fallback.)
5. `clearToolsetEntry` / `clearAllToolsetEntries` + `applyToolsetEnabled`
   - tests. (Port toolset tombstone helpers from the branch; write
   `applyToolsetEnabled` fresh.)
6. `"allowlist"` mode: `DefaultResolutionMode` type change,
   `setDefaultResolutionMode` signature, `doRestore` allowlist
   short-circuit, `getActiveAllowlist` + tests. (New.)
7. `doRestore` mode resolution: null-tombstone-aware, `branchMode ??
   "exclusion"`, no settings fallback + tests. (Revise the branch's mode
   block; drop the settings fallback.)
8. `CHANGELOG.md` `[Unreleased]` + README API section.

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
