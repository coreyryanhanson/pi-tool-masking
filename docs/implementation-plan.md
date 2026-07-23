# pi-tool-masking — Implementation Plan

> Source of truth: [`design.md`](./design.md). This plan operationalizes it.
> Status: **library code complete** (Sprints 0–4 + the review-fix pass) but
> **not yet published**. The library has not shipped — it made it through the
> Sprints but remains under review. We will not publish until the later
> stages (consumer migration + manager) are done. A minimum implementation of
> the manager extension will be built first, giving us flexibility to debug
> issues before locking ourselves to the API.

## Scope & sequencing

**Done in this repo:** built the `pi-tool-masking` library (`initial-commit`
branch), then ran a review and applied the documented fixes. The library is
**not published** — it exists only on the `initial-commit` branch.

**Pending (manager extension, built before publishing):** a minimum
implementation of the user-facing manager extension (§13 in design.md) will
be built *before* the library is published. This gives us flexibility to
debug issues against a real consumer before locking ourselves to the API.
The manager is built in this repo (or a sibling repo) as a real pi
extension that depends on `pi-tool-masking`, exercises the globalThis
registry convergence, and validates the event surface — catching any
integration bugs that the library's own MockPI tests cannot.

**Pending (in the `pi-lean-dimension` monorepo):** migrate **`main`**
(portal + search) onto the library and cut the `0.3.x` release.

**Out of scope (host):** `pi-lean-host` is *not* migrated in this plan. The
`feat/pi-lean-host` branch is used only as (a) a code reference when porting
the shared toggle logic, and (b) a rebase target — Sprint 9 verifies it rebases
cleanly onto the updated `main`. Host's own migration ships later as `0.4.x`.

**Why this order:** main has no host package, so it is the smaller, cleaner
migration and lands the library + invariant in one place first. The host
branch then rebases onto a main that already depends on `pi-tool-masking`, so
its eventual migration is a single-package change rather than a foundational
one. The manager is built before publishing so we can debug against a real
consumer before locking ourselves to the API.

### Repos & branches at a glance

| Repo | Branch | Role | Status |
|------|--------|------|--------|
| `pi-tool-masking` (this repo) | `initial-commit` | Library implementation | ✅ code complete, **not published** |
| TBD (new repo) | `main` | Minimum manager extension | ⏳ to build before publishing |
| `pi-lean-dimension` (monorepo) | `main` | Portal + search migration → `0.3.0` | ⏳ pending |
| `pi-lean-dimension` (monorepo) | `feat/pi-lean-host` | Reference + rebase check only | ⏳ pending |

### Versioning

- Library: `pi-tool-masking` will ship `1.0.0` (stable v1 API surface per §5; the
  persist schema and `DefaultResolutionMode` are frozen from v1 per §4.5/§7).
  **Not yet published** — still under review.
- Manager: a minimum implementation built in this repo before publishing,
  exercising the globalThis registry convergence and event surface against
  a real pi extension lifecycle.
- Consumers (pending): portal + search + dimension bump `0.2.4 → 0.3.0` and add
  `pi-tool-masking` as a hard `dependency` (`^1.0.0`).
- Host (later, out of scope): `0.4.0` when it migrates.
- Lockstep across the four repos via the monorepo's `scripts/sync-versions.js`
  discipline (extended to cover the new external dep — see Sprint 7).

### Current main-branch baseline (verified, still the migration starting point)

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

## Completed — Sprints 0–4 (library)

All four library sprints shipped on the `initial-commit` branch. `npm test` is
green: **86 tests across 2 files** (`core.test.ts`, `registry-convergence.test.ts`).
What each sprint delivered:

### Sprint 0 — Library scaffolding ✅

A loadable, source-only TypeScript package (`package.json`: `name:
"pi-tool-masking"`, `version: "1.0.0"`, `type: "module"`, no default factory,
no `extensions/` manifest, no `pi-package` keyword). `tsconfig.json` mirrors
the monorepo's strict flags (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `module: "nodenext"`, `isolatedModules`,
`moduleDetection: "force"`, `noUncheckedSideEffectImports`, `noEmit: true`).
`index.ts` exports the full §5 surface. The test harness `__tests__/mock-pi.ts`
ships a `MockPI` implementing the masking-relevant `ExtensionAPI` subset:
`setActiveTools` / `getActiveTools` / `getAllTools` (returns `ToolInfo[]`
objects, not strings) / `appendEntry` (records writes keyed by `customType`) /
`on` / `events` (a real Node `EventEmitter`) / `registerTool`, plus
`sessionManager.getBranch()` returning the recorded `SessionEntry[]`. Restore
reads via `ctx.sessionManager.getBranch()` — `ExtensionAPI` has no `readEntry`
counterpart to `appendEntry` — so the mock exposes `getBranch()`, not a
fictional `readEntry`.

### Sprint 1 — Core primitives ✅

`defineToolset` / `enable` / `disable` / `isEnabled` with the §9
peer-composition invariant and the §6.1 globalThis registry + collision policy.
Registry on `globalThis.__piToolMaskingRegistry`, idempotent init, keyed by
`spec.id`. Collision policy throws on a duplicate `spec.id` (different spec)
and on a duplicate `persistKey`, but is **idempotent by content** for
`deepEqual`-identical re-registration (the `/reload`/`/resume` case — returns
the existing handle, no throw). `enable` is additive
(`[...new Set([...current, ...registered])]`, `registered = spec.names ∩
getAllTools()`); `disable` filters `spec.names` out of `getActiveTools()` (not
`getAllTools()`). Both idempotent. Tests: peer composition, additive-enable,
disable-uses-getActiveTools, collision throws, idempotent re-registration,
registry idempotency, enable/disable idempotency.

### Sprint 2 — `requires` cascade + default-resolution mode ✅

`enable` transitively enables `spec.requires` (graph walk with visited-stack);
`disable` reverse-cascades to every toolset whose `requires` contains this
one's id. Cycle detection is lazy (first graph resolution, not
`defineToolset` time) — the walk throws on a stack revisit, naming the cycle
path (`A → B → C → A`). Forward-references are allowed (a `requires` id not yet
registered is skipped until it appears). `setDefaultResolutionMode` /
`getDefaultResolutionMode` store the library-level mode in globalThis state
(default `"exclusion"`). Tests: dependency cascade (all four §9 directions),
cycle throw with path, forward-reference, mode set/get, no-path-yields-
`L.enabled && !B.enabled`.

### Sprint 3 — Restore, events, `readMergedSettings` ✅

The `session_start` / `session_tree` restore handler (registered in Sprint 1,
bodied here): per registered toolset, read `spec.persistKey` from
`ctx.sessionManager.getBranch()`; an entry → apply its `enabled`, emit
`restored`; no entry → resolve `spec.defaultEnabled` under exclusion mode or
`false` under inclusion mode, apply, emit `changed`, and **do not call
`appendEntry`** (restore never persists a default fallback, §6). Always emits
exactly one event per toolset per restore (the always-emit invariant).
`TOOLSET_EVENTS` (`changed`/`restored`) + `ToolsetChangedEvent` payloads with
optional `emitMemberEvents` per-member fanout. `readMergedSettings()` merges
global + project settings (project wins), returns `{}` on any failure, never
throws. Tests: persistence round-trip, no-entry restore (exclusion +
inclusion), always-emit, the `changed`/`restored` split, `emitMemberEvents`
N+1 fanout, idempotent/last-writer-wins restore, `session_tree` restore,
`readMergedSettings` merge + error handling, default-resolution entry-vs-
no-entry.

### Sprint 4 — Library test suite complete (§12) ✅

The novel **globalThis registry convergence test**
(`__tests__/registry-convergence.test.ts`): simulates two isolated module
loads against one shared `globalThis` — registers a toolset from copy A,
asserts copy B's registry enumerates it. This is the one mechanism that cannot
be verified by reading code alone. All §12 bullets are covered in this repo;
no invariant test is duplicated in a consumer repo (consumers not yet
migrated — asserted in Sprints 5/6).

---

## Pending — Sprint 5 — Portal migration (monorepo `main`)

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

---

## Pending — Sprint 6 — Search migration (monorepo `main`)

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

---

## Pending — Sprint 7 — Version bump, dependency wiring, release prep (`0.3.0`)

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

---

## Pending — Sprint 8 — Verify `feat/pi-lean-host` rebases cleanly

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

---

## Cross-cutting acceptance (whole plan)

- [x] The peer-composition invariant (§9) and the `requires` cascade (§4.4)
      have **exactly one** test home: `pi-tool-masking`'s repo. (Library side
      done; confirmed no consumer duplication once Sprints 5/6 land.)
- [ ] `rg "web-toggle-state|api-toggle-state"` across the monorepo `main`
      returns only CHANGELOG/history references — the old persist keys are gone
      from live code.
- [ ] `rg "settings-reader"` across the monorepo `main` returns nothing — both
      copies are deleted, replaced by `readMergedSettings`.
- [x] `globalThis.__piToolMaskingRegistry` is the only cross-instance shared
      surface; toggle actuation remains a static import (§6.1 boundary).
- [x] The restore handler is `/reload`-safe via event-object-identity dedup
      (review Finding 1) — verified by the regression test.
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
