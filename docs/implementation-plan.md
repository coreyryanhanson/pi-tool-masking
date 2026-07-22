# pi-tool-masking — Implementation Plan

> Source of truth: [`design.md`](./design.md). This plan operationalizes it.
> Status: draft (pre-implementation).

## Scope & sequencing

**In scope:** build the `pi-tool-masking` library (in this repo, `initial-commit`
branch), then migrate **`main`** of the `pi-lean-dimension` monorepo (portal +
search) onto it, and cut the `0.3.x` release.

**Out of scope (host):** `pi-lean-host` is *not* migrated in this plan. The
`feat/pi-lean-host` branch is used only as (a) a code reference when porting
the shared toggle logic, and (b) a rebase target — Sprint 8 verifies it rebases
cleanly onto the updated `main`. Host's own migration ships later as `0.4.x`.

**Why this order:** main has no host package, so it is the smaller, cleaner
migration and lands the library + invariant in one place first. The host
branch then rebases onto a main that already depends on `pi-tool-masking`, so
its eventual migration is a single-package change rather than a foundational
one.

### Repos & branches at a glance

| Repo | Branch | Role |
|------|--------|------|
| `pi-tool-masking` (this repo) | `initial-commit` | Library implementation |
| `pi-lean-dimension` (monorepo) | `main` | Portal + search migration → `0.3.0` |
| `pi-lean-dimension` (monorepo) | `feat/pi-lean-host` | Reference + rebase check only |

### Versioning

- Library: `pi-tool-masking` ships `1.0.0` (stable v1 API surface per §5; the
  persist schema and `DefaultResolutionMode` are frozen from v1 per §4.5/§7).
- Consumers: portal + search + dimension bump `0.2.4 → 0.3.0` and add
  `pi-tool-masking` as a hard `dependency` (`^1.0.0`).
- Host (later, out of scope): `0.4.0` when it migrates.
- Lockstep across the four repos via the monorepo's `scripts/sync-versions.js`
  discipline (extended to cover the new external dep — see Sprint 7).

### Current main-branch baseline (verified)

- `packages/pi-lean-portal/browser-toggle.ts` — 497 lines, owns toggle +
  restore + `setSearchSlot` reach-through + `SIBLING_TOOL_NAMES`.
- `packages/pi-lean-portal/__tests__/browser-toggle.test.ts` — 80 tests.
- `packages/pi-lean-portal/__tests__/browser-toggle-profile.test.ts` — 14 tests.
- `packages/pi-lean-search/index.ts` — 260 lines, owns `search` glyph + health
  probe + `session_shutdown` cleanup.
- One `settings-reader.ts` at `packages/pi-lean-portal/core/shared/`.
- No `pi-lean-host` on `main`.
- All three published packages at `0.2.4`.

---

## Sprint 0 — Library scaffolding

**Repo:** `pi-tool-masking`, `initial-commit` branch.
**Goal:** a loadable, testable TypeScript package with the public type surface
from §5 declared (bodies can be stubs), so Sprint 1–4 fill it in against a
stable shape.

**Work:**

1. `package.json` — `name: "pi-tool-masking"`, `version: "1.0.0"`, `type:
   "module"`, no `pi` manifest / no default factory (it is a library, §1/§14),
   `keywords` **without** `pi-package` (§14 — not gallery-marketed). `devDependencies`:
   `vitest`, `@earendil-works/pi-coding-agent` (for the `ExtensionAPI` type),
   `@types/node`.
2. `tsconfig.json` mirroring the monorepo's strict flags
   (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `module:
   "nodenext"`, `isolatedModules`, `moduleDetection: "force"`,
   `noUncheckedSideEffectImports`, `noEmit: true`) — the §5 doc calls out
   `exactOptionalPropertyTypes` specifically for the conditional-spread pattern.
3. `index.ts` exporting the §5 surface as stubs: `ToolsetSpec`, `Toolset`,
   `ToolsetChangedEvent`, `DefaultResolutionMode`, `TOOLSET_EVENTS`,
   `defineToolset`, `setDefaultResolutionMode`, `getDefaultResolutionMode`,
   `readMergedSettings`. No bodies yet beyond `throw new Error("not
   implemented")` / `return "exclusion"`.
4. `__tests__/` dir with a `mock-pi.ts` harness: a `MockPI` implementing
   `ExtensionAPI`'s masking-relevant subset — `setActiveTools` / `getActiveTools`
   / `getAllTools` (returns `ToolInfo[]` objects `{ name, description, ... }`,
   matching the real `ExtensionAPI.getAllTools()` return type — **not** plain
   strings) / `appendEntry` (records writes keyed by `customType`) / `on` /
   `events` (a real Node `EventEmitter` stood up as the `EventBus`).
   `registerTool` so `getAllTools` can be populated. This is the §12 MockPI.

   **Restore reads via `ctx.sessionManager.getBranch()`, not `pi.readEntry`.**
   `ExtensionAPI` has no read counterpart to `appendEntry` (verified in pi's
   `types.d.ts`); the real restore path reads entries via the `ctx` parameter
   from the event handler signature `(event, ctx) => ...` —
   `ctx.sessionManager.getBranch()` returns `SessionEntry[]` with
   `type` / `customType` / `data` fields (matching the existing
   `browser-toggle.test.ts` mock at `sessionManager: { getBranch: vi.fn(...) }`).
   The MockPI therefore exposes a `sessionManager.getBranch()` that returns the
   recorded entries, **not** a fictional `pi.readEntry`.
5. `npm test` runs (a single trivial placeholder test) green.

**Acceptance criteria:**

- [ ] `npm test` is green with zero real tests (only the placeholder).
- [ ] `import { defineToolset, TOOLSET_EVENTS } from "../index.js"` resolves in
      a `.test.ts` file with no type errors under `tsc --noEmit`.
- [ ] `package.json` has no default factory, no `extensions/` manifest, and no
      `pi-package` keyword.
- [ ] `MockPI` supports `setActiveTools`/`getActiveTools`/`getAllTools`
      (returning `ToolInfo[]` objects, not strings)/`appendEntry`/
      `sessionManager.getBranch()` (returning recorded `SessionEntry[]`)/`on`/
      `events.emit` and is exercised by one trivial round-trip test. The mock
      **must not** expose a `readEntry` method (none exists on `ExtensionAPI`).

**Skipped:** nothing — this is the minimum to make subsequent sprints testable.

---

## Sprint 1 — Core primitives: `defineToolset`, `enable`/`disable`, registry

**Goal:** the peer-composition invariant (§9) and the globalThis registry
(§6.1) with its collision policy, behind the §5 API.

**Work:**

1. `defineToolset(pi, spec)`: validate `spec.id` / `spec.persistKey` are
   non-empty; record `{ spec, toolset }` in the registry; return a `Toolset`
   with `enable` / `disable` / `isEnabled`. Register the `session_start` /
   `session_tree` restore handler here (body filled in Sprint 3, registered now
   so ordering is correct — §6 capture-ordering note).
2. **Registry on `globalThis.__piToolMaskingRegistry`** (§6.1): idempotent init,
   keyed by `spec.id`. **Collision policy (v1):** `defineToolset` throws on a
   duplicate `spec.id` **and** on a duplicate `persistKey` (§6.1) — **except**
   when the duplicate is an idempotent re-registration of the same toolset from
   the same source (see §6.1's reload/resume-safe re-registration rule, below).
   Error message names the colliding id/key.

   **Reload/resume-safe re-registration.** The registry lives on `globalThis`,
   which pi does **not** clear on `/reload` or `/resume` (verified in pi's
   `agent-session.js` reload path). Both reload (jiti re-evaluates the module
   and re-invokes every factory) and `/resume` (re-invokes the factory against
   the cached module) call `defineToolset` again with the same `spec.id`. A
   naive throw-on-duplicate would break both paths. The current `browser-toggle`
   code dodges this with module-level state + an explicit `resetToggleModuleState()`
   call; the library cannot, because the registry's whole purpose is to persist
   across module copies. Resolution: **`defineToolset` is idempotent by content**
   — a second call with the same `id` + a `deepEqual`-identical `spec` is a
   no-op that returns the existing `Toolset` handle (the reload/resume case,
   no edit in between); a second call with the same `id` + a changed `spec`
   replaces the entry and warns (reload after an edit). A genuine cross-
   extension same-`id` collision (two different extensions, same `id`,
   non-`deepEqual` specs) still throws — that is the programmer error the
   collision guard exists for. This keeps the registry persistent for its
   cross-instance purpose without making `/reload` or `/resume` fatal. (See
   design §6.1 for the full rationale and the `deepEqual` choice.)
3. `enable(pi)`: additive — `[...new Set([...current, ...registered])]` where
   `registered = spec.names ∩ pi.getAllTools()` (tolerates unregistered names,
   §4.1). Idempotent: no-op + no emit if already in target state.
4. `disable(pi)`: filters `spec.names` out of `pi.getActiveTools()` — **not**
   `getAllTools()` (§9). Idempotent.
5. `isEnabled(pi)`: any member of `spec.names` present in `pi.getActiveTools()`
   (matches today's `isBrowserEnabled` partial semantics).
6. `appendEntry` write on every `enable`/`disable` call: `spec.persistKey` →
   `{ enabled }`. (Restore reads it in Sprint 3.)

**Acceptance criteria:**

- [ ] **Peer composition (§9 canonical test):** toolsets A, B both enabled;
      `disable(A)` → A's tools gone, B's tools remain; `disable(B)` → A's tools
      are **not** re-activated. One test, in this repo.
- [ ] `enable` is additive and never drops tools another toggle removed
      (assert against a MockPI with a third disabled toolset's members absent).
- [ ] `disable` uses `getActiveTools()`, not `getAllTools()` — verified by a
      test that pre-disables a peer toolset and asserts `disable` does not
      revive it.
- [ ] Duplicate `spec.id` from a *different* spec throws; duplicate
      `persistKey` throws; distinct ids/keys register cleanly.
- [ ] **Idempotent re-registration:** a second `defineToolset` with the same
      `id` + a `deepEqual`-identical `spec` returns the existing handle and
      does **not** throw (simulates `/reload` / `/resume` re-entry); a second
      call with the same `id` + a changed `spec` replaces and warns.
- [ ] `globalThis.__piToolMaskingRegistry` is initialized idempotently (assert
      the same object survives a second `defineToolset` in the same process).
- [ ] Idempotent: `enable` then `enable` writes once and emits once; same for
      `disable`.
- [ ] `globalThis.__piToolMaskingRegistry` is initialized idempotently (assert
      the same object survives a second `defineToolset` in the same process).

**Skipped:** `requires` cascade (Sprint 2), restore + events (Sprint 3), the
multi-instance convergence test (Sprint 4 — needs the cache-clear harness).

---

## Sprint 2 — `requires` cascade + default-resolution mode

**Goal:** the dependency primitive (§4.4) and the mode bit (§4.5).

**Work:**

1. `enable(pi)` now transitively `enable`s every `spec.requires` id before
   applying its own change, via a graph walk with a visited-stack.
2. `disable(pi)` cascades `disable` to every registered toolset whose `requires`
   contains this one's id (and transitively).
3. **Cycle detection (§4.4):** the walk throws on a revisit in the current
   stack — `Error` naming the cycle path (`A → B → C → A`). Lazy: detected at
   first graph resolution, not at `defineToolset` time (forward-references
   allowed). No separate validation pass.
4. `setDefaultResolutionMode(pi, mode)` / `getDefaultResolutionMode(pi)` —
   library-level, persisted to in-memory state (not `appendEntry`; the mode is
   runtime policy, not conversation state). Default `"exclusion"`.

**Acceptance criteria:**

- [ ] **Dependency cascade (§9 canonical test):** `L requires [B]`; `enable(L)`
      → B enabled; `disable(B)` → L disabled; `enable(L)` while B independently
      disabled re-enables B. No path yields `L.enabled && !B.enabled`.
- [ ] Cycle throws with the path in the message; the throw is raised on the
      first `enable`/`disable` that traverses the cycle, not at `defineToolset`.
- [ ] Forward-reference: `defineToolset(A)` with `requires: ["B"]` before B is
      registered does **not** throw; `enable(A)` after B registers works.
- [ ] **Mode test (§12):** toolset A (entry, enabled) + toolset B (no entry);
      exclusion → B defaults on; inclusion → B defaults off; A's entry honored
      in both. (Uses the restore path from Sprint 3 — wire the assertion once
      Sprint 3 lands, but the mode setter/getter is testable now against the
      in-memory default.)

**Skipped:** restore wiring (Sprint 3) — the mode is settable now, its
restore-path effect is asserted once restore exists.

---

## Sprint 3 — Restore, events, `readMergedSettings`

**Goal:** conversation-state ownership (§7), the `changed`/`restored` event
split (§6), and the shared settings reader (§5).

**Work:**

1. **Restore handler** (registered in Sprint 1, bodied now): on
   `session_start` and `session_tree`, for each registered toolset:
   - read `spec.persistKey` from branch state via the event handler's `ctx` —
     `ctx.sessionManager.getBranch()` returns `SessionEntry[]`; filter by
     `entry.customType === spec.persistKey` and read `entry.data` (this is the
     real `ExtensionAPI` read path; `pi` itself has no `readEntry` method —
     see Sprint 0's MockPI note);
   - **entry exists** → apply its `enabled`, emit `restored` (one group-level
     event; member fanout if `emitMemberEvents`);
   - **no entry** → resolve to `spec.defaultEnabled` under exclusion mode, or
     `false` under inclusion mode (§4.5); apply; emit `changed`; **do not call
     `appendEntry`** (§6 — restore never persists a default fallback).
   - Always emits exactly one event per toolset per restore (the always-emit
     invariant, §6). No skip-on-equals-default.
2. **`TOOLSET_EVENTS`** constant + `ToolsetChangedEvent` payloads emitted from
   `enable`/`disable` (`changed`) and restore (`changed` | `restored`). Group
   event always fires; `emitMemberEvents` adds per-member fanout with
   `event.member` set.
3. **`readMergedSettings()`** export (§5): reads `~/.pi/agent/settings.json` +
   project `.pi/settings.json`, project overrides global, returns `{}` on any
   failure. The library never calls this itself (restore uses
   `spec.defaultEnabled`); it is a utility so consumers delete their
   `settings-reader.ts` copies.

**Acceptance criteria:**

- [ ] **Persistence round-trip (§12):** `disable` writes `{ enabled: false }`
      under `persistKey`; a subsequent restore reads it, applies false, emits
      `restored`.
- [ ] **No-entry restore (exclusion):** entry-less toolset with
      `defaultEnabled: true` → applies on, emits `changed`, does **not** write
      `appendEntry`. Assert the entry count is unchanged after restore.
- [ ] **No-entry restore (inclusion):** same toolset → applies off, emits
      `changed`, no `appendEntry`.
- [ ] **Always-emit:** restore emits exactly one event per registered toolset,
      even when the resolved state equals the current in-memory state.
- [ ] `changed` fires on `enable`/`disable` + default-fallback restore;
      `restored` fires **only** on persisted-entry restore. A test asserts the
      split by inspecting event type + payload.
- [ ] `emitMemberEvents: true` produces N+1 events (1 group + N members) on a
      toggle; `false` produces 1. Members carry `event.member`.
- [ ] `readMergedSettings()` merges global + project (project wins), returns
      `{}` on missing/malformed files, never throws.
- [ ] Restore is idempotent / last-writer-wins: a second restore on the same
      branch produces the same state and does not double-write.

**Skipped:** the multi-instance globalThis convergence test (Sprint 4) and the
full §10.1 companion-matrix assertion (Sprint 6, after search migrates).

---

## Sprint 4 — Library test suite complete (§12)

**Goal:** every test §12 names lives in this repo, including the novel
globalThis convergence test.

**Work:**

1. **GlobalThis registry convergence test (§12, required):** simulate two
   isolated module loads against one shared `globalThis` — clear the module
   cache, re-import the library under a fresh jiti/require context, register a
   toolset from copy A, assert copy B's registry enumerates it. This is the one
   mechanism that cannot be verified by reading code alone.
2. Consolidate Sprint 1–3 tests into the §12 shape: peer composition,
   dependency cascade, cycle throw, persistence round-trip, default-resolution
   mode, always-emit/split.
3. Add a `demo()`/self-check or one focused test for the §9 invariant line
   (the `getActiveTools`-not-`getAllTools` disable) so the single load-bearing
   rule has its own failing-if-broken check.

**Acceptance criteria:**

- [ ] The globalThis convergence test passes and fails deliberately if the
      registry is moved to module-level state (verify by temporarily reverting
      and watching it go red).
- [ ] `npm test` in this repo is green and covers every §12 bullet.
- [ ] No invariant test is duplicated in a consumer repo (the §12
      "one home for the invariant" rule) — this is a review check, asserted in
      Sprint 5/6 by confirming portal/search tests are thin integration only.

**Skipped:** consumer-side tests (Sprint 5/6).

---

## Sprint 5 — Portal migration (monorepo `main`)

**Repo:** `pi-lean-dimension`, `main` branch.
**Goal:** `browser-toggle.ts` collapses onto the library per §10.

**Work:**

1. Add `pi-tool-masking` (`^1.0.0`) to `packages/pi-lean-portal/package.json`
   `dependencies`. `npm install` to wire it.
2. Rewrite `browser-toggle.ts` to the §10 shape:
   - `defineToolset` for `portal.web` (`BROWSER_TOOL_NAMES`, `defaultEnabled`
     from `readMergedSettings().browserToggle?.defaultEnabled ?? true`) and
     `portal.learn` (`LEARN_TOOL_NAMES`, `defaultEnabled: false`, `requires:
     ["portal.web"]`).
   - `/web` command handler ~10 lines dispatching to `enable`/`disable`; `learn`
     pulls web on via `requires`; `off` cascades learn off via `requires`.
   - Delete: `SIBLING_TOOL_NAMES`, `setSearchSlot`, the search reach-through,
     `restoreFromBranch`, `applyConfigDefault`, the `session_start`/`session_tree`
     restore wiring.
   - Keep `defaultProfile` as a separate `appendEntry("portal-conversation-state",
     { defaultProfile })` (§7).
   - Glyph: portal's own `changed`/`restored` listener rendering the `browser`
     slot; `render()` called from inside the `session_start` capture handler
     (§6 capture-ordering fix).
3. Delete `packages/pi-lean-portal/core/shared/settings-reader.ts` — replaced
   by `readMergedSettings` from the library. Grep for any other importer first.
4. Update `packages/pi-lean-portal/index.ts` imports if the toggle export
   surface changed.
5. **Tests:** delete the 80 `browser-toggle.test.ts` tests that duplicated the
   invariant (peer composition, persist shape, restore) — those now live in the
   library. Keep/rewrite **thin integration tests** that call `defineToolset`
   against a MockPI and assert portal-specific concerns: the `/web` command
   dispatch, the glyph render, `defaultProfile` persistence, the
   `portal-conversation-state` split. Keep the 14 profile tests (they test
   portal-specific profile behavior, not the invariant).

**Acceptance criteria:**

- [ ] `browser-toggle.ts` is ≤ ~150 lines (down from 497).
- [ ] `packages/pi-lean-portal/core/shared/settings-reader.ts` is deleted and
      no importer remains (`rg settings-reader` in the portal package is empty).
- [ ] `SIBLING_TOOL_NAMES` / `setSearchSlot` are gone; `rg setSearchSlot` and
      `rg SIBLING_TOOL_NAMES` are empty across the monorepo.
- [ ] `/web on`, `/web off`, `/web learn` behave exactly as before against a
      MockPI (assertion tests), with the `requires` cascade doing the
      composition — no hand-written learn↔web coupling in portal.
- [ ] `defaultProfile` persists under `portal-conversation-state`, separate
      from `toolset-state:portal.*` entries.
- [ ] Portal's `browser` glyph renders on `session_start` regardless of
      handler registration order (the capture-ordering fix) — one test
      simulates `defineToolset` called before the capture handler.
- [ ] `npx vitest run packages/pi-lean-portal` is green; no invariant test is
      duplicated here (review check).
- [ ] No portal test reaches into the library's internal registry — it uses
      only the public API.

**Skipped:** host migration (out of scope); search migration (Sprint 6).

---

## Sprint 6 — Search migration (monorepo `main`)

**Goal:** search owns its own `search.web` toolset and co-activates off
`portal.web`'s `changed` event per §10/§10.1.

**Work:**

1. Add `pi-tool-masking` (`^1.0.0`) to `packages/pi-lean-search/package.json`
   `dependencies`.
2. In `packages/pi-lean-search/index.ts`:
   - `defineToolset` for `search.web` (`new Set(["web-search"])`,
     `defaultEnabled: true`).
   - Co-activation listener on `TOOLSET_EVENTS.changed` for `id ===
     "portal.web"`: `enable`→`searchToolset.enable(pi)`,
     `disable`→`searchToolset.disable(pi)`. Listen on `changed` **only**, not
     `restored` (§10.1).
   - Glyph listener on `search.web`'s own `changed`/`restored`, rendering the
     `search` slot. `render()` called from inside the `session_start` capture
     handler.
   - Keep the existing `session_shutdown` glyph cleanup (§10 — consumer-owned).
   - Keep the SearXNG health probe; the glyph reflects `search.web` activation
     - health color.
3. Portal no longer references search at all — verify no import/identifier
   coupling remains.

**Acceptance criteria:**

- [ ] The §10.1 companion matrix holds as tests:
      - Fresh, config off → `portal.web` `changed` → `search.web` mirrors off.
      - Fresh, default on → mirrors on.
      - Restart after `/web off` → `portal.web` `restored` (persisted false),
        `search.web` restores its own persisted false (not re-mirrored).
      - Restart, manager-disabled search with portal on → `portal.web`
        `restored` true, `search.web` restores its own persisted false.
- [ ] `search.web` co-activation listens on `changed` only — a test asserts no
      `searchToolset.enable/disable` call fires on a `restored` event for
      `portal.web`.
- [ ] Portal has zero references to search (`rg -i search` in
      `packages/pi-lean-portal/browser-toggle.ts` is empty).
- [ ] `session_shutdown` still clears the `search` glyph.
- [ ] `npx vitest run packages/pi-lean-search` is green.

**Skipped:** the deferred `companions: string[]` primitive (§10.1 — one group
today does not justify it).

---

## Sprint 7 — Version bump, dependency wiring, release prep (`0.3.0`)

**Goal:** cut the `0.3.x` release with `pi-tool-masking` as a hard dep.

**Work:**

1. Publish (or stage) `pi-tool-masking@1.0.0` from the `initial-commit` branch.
   Confirm the tarball has no `extensions/` manifest and no `pi-package`
   keyword (§14).
2. Bump portal + search + dimension `0.2.4 → 0.3.0` (lockstep). Add
   `pi-tool-masking: ^1.0.0` to portal + search `dependencies`; dimension's
   `bundledDependencies` picks it up transitively.
3. Extend `scripts/sync-versions.js` if needed so the external
   `pi-tool-masking` dep is kept in lockstep with the published version across
   consumers (the script currently handles intra-monorepo deps only — add a
   pinned-external-dep check or document the manual step).
4. `npm run publish:dry` — inspect tarballs: portal + search + dimension
   include `pi-tool-masking` in their resolved dep tree; the library tarball
   is library-only.
5. Update `CHANGELOG.md` with the `0.3.0` entry: new hard dep
   `pi-tool-masking`, toggle logic extracted, `session_tree` behavior change
   on entry-less branches (§7.1 — intentional improvement), no legacy
   migration (§8 — old branches reset to defaults; browser state unaffected).

**Acceptance criteria:**

- [ ] `pi-tool-masking@1.0.0` publishes and `npm view pi-tool-masking` shows no
      `pi-package` keyword and no extension manifest.
- [ ] `npm run publish:dry` succeeds; portal/search/dimension tarballs resolve
      `pi-tool-masking` at `^1.0.0`.
- [ ] All three consumer packages report `0.3.0`; `npm run sync-versions` (or
      equivalent) confirms lockstep.
- [ ] `npm test` (full structural suite) is green on `main`.
- [ ] CHANGELOG documents the `session_tree` entry-less-branch behavior change
      and the no-legacy-migration stance.

**Skipped:** the actual `npm run publish` (release execution is a separate
human step); host release (0.4.x, out of scope).

---

## Sprint 8 — Verify `feat/pi-lean-host` rebases cleanly

**Goal:** confirm the host branch is not blocked by the main migration — it
should rebase onto the updated `main` with only host-package conflicts
resolvable by reference to the same library.

**Work:**

1. From `feat/pi-lean-host`, `git rebase main` (updated in Sprint 7).
2. Expected conflict surface: `browser-toggle.ts`-adjacent files are not on the
   host branch, so portal/search migrations should apply cleanly; the host
   branch's own `packages/pi-lean-host/core/api-toggle.ts` and
   `core/settings-reader.ts` are untouched by main's migration and should not
   conflict. Where conflicts arise, resolve by reference to the §10 host block
   (the `host.api` / `api-toggle-state` collapse is the *future* 0.4.x work —
   do **not** migrate host here, just make the tree consistent).
3. Run the structural test suite on the rebased branch (host tests auto-skip
   without backends; the portal/search structural tests must stay green).

**Acceptance criteria:**

- [ ] `feat/pi-lean-host` rebases onto updated `main` with no unresolved
      conflicts after resolution.
- [ ] `npm run test:ci` is green on the rebased branch (host contract tests
      auto-skip; structural + portal + search pass).
- [ ] No host source files are modified by the rebase beyond what the rebase
      itself requires — host migration is explicitly deferred to 0.4.x.
- [ ] The rebased branch's `packages/pi-lean-host/core/api-toggle.ts` still
      compiles (tsc clean) — it is the reference for the eventual 0.4.x
      migration, unchanged in behavior.

**Skipped:** the host migration itself (0.4.x, out of scope per the plan).

---

## Cross-cutting acceptance (whole plan)

- [ ] The peer-composition invariant (§9) and the `requires` cascade (§4.4)
      have **exactly one** test home: `pi-tool-masking`'s repo. No consumer
      re-tests them.
- [ ] `rg "web-toggle-state|api-toggle-state"` across the monorepo `main`
      returns only CHANGELOG/history references — the old persist keys are gone
      from live code.
- [ ] `rg "settings-reader"` across the monorepo `main` returns nothing — both
      copies are deleted, replaced by `readMergedSettings`.
- [ ] `globalThis.__piToolMaskingRegistry` is the only cross-instance shared
      surface; toggle actuation remains a static import (§6.1 boundary).
- [ ] `npm test` is green on `main` at `0.3.0` and on `feat/pi-lean-host`
      rebased onto it.

## Out-of-scope reminders (do not accidentally do)

- Do **not** migrate `pi-lean-host` onto the library in this plan (0.4.x).
- Do **not** build the deferred manager extension (§13).
- Do **not** add a `companions: string[]` primitive (§10.1 — one group today).
- Do **not** add a `focus()` verb or `getToggleUnits()` helper (§13.2 — manager
  concerns).
- Do **not** add a legacy persistence migration read path (§8).
- Do **not** tag the library `pi-package` in `keywords` (§14).
