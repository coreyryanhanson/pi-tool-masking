# Review Fix Plan — pi-tool-masking

Scope: address the five findings from the library review. Verified against
`@earendil-works/pi-coding-agent` dist source (runner.js:565 `emit(event)`
passes one shared `event` reference to every extension's handler;
agent-session.js:2074 `/reload` emits a fresh `{ type: "session_start",
reason: "reload" }` object literal each time; session_tree and resume/new/fork
likewise construct fresh event objects).

Legend: 🔴 must fix · 🟡 small fix · 🟢 comment/test only.

---

## Finding 1 (HIGH) — Restore handler is not /reload-safe

### Root cause

`ensureRestoreHandler` guards registration with a boolean on `globalThis`
(`HANDLER_GUARD_KEY`). On `/reload`, pi discards the old `Extension` and its
handler maps and builds fresh ones (`resourceLoader.reload()` →
`loadExtensions` → new `ExtensionAPI` per extension), but `globalThis` is
**not** cleared. So:

1. `globalThis.__piToolMaskingRestoreHandlerRegistered` stays `true`.
2. `defineToolset(newPi, spec)` → `ensureRestoreHandler` returns early → no
   restore handler on the new extension.
3. `ExtensionRunner.emit({ type: "session_start", reason: "reload" })`
   dispatches to the new extensions' (empty) handlers → restore silently
   never runs.

The old captured `pi` is also invalidated (stale guard), so even the
discarded handler would throw. No test covers this — every test uses a
single `MockPI` that never recreates handlers.

### Fix

Drop the boolean guard. Dedup by **event-object identity** instead:

- The runner passes the same `event` reference to every extension's handler
  in one `emit()` call → first handler per event wins, the rest no-op.
- Each `/reload` (and each `session_start`/`session_tree`/resume/fork emit)
  constructs a fresh event object → restore re-runs with a fresh `pi`.
- This subsumes the original "register only once across toolsets" concern:
  the dedup is now runtime, not registration-time.

Consequence: `ensureRestoreHandler` now registers a handler on **every**
`defineToolset` call (N handlers per extension). They are cheap and the
event-identity dedup guarantees restore runs exactly once per event. No
per-`pi` registration guard is needed.

### Changes — `index.ts`

- Remove `HANDLER_GUARD_KEY` constant.
- Rewrite `ensureRestoreHandler`:
  - Define `doRestore` inside it (closes over the current `pi`).
  - First line of `doRestore`: if
    `globalThis.__piToolMaskingLastRestoreEvent === event`, return.
  - Otherwise set `globalThis.__piToolMaskingLastRestoreEvent = event` and
    run the existing restore body.
  - Register `pi.on("session_start", doRestore)` and
    `pi.on("session_tree", doRestore)` unconditionally.
- Add constant `RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent"`.

### Changes — `__tests__/core.test.ts`

- `cleanRegistry()`: also `delete globalThis[RESTORE_EVENT_KEY]` (rename the
  deleted key; drop the `HANDLER_GUARD_KEY` delete).
- Update **`registers handlers only once across multiple toolsets`**: under
  the new model `handlerCount("session_start")` is 2 (one per `defineToolset`
  call). Replace the registration-count assertion with a **runtime dedup**
  assertion: register two toolsets, fire `session_start` once, assert restore
  applies/emits exactly once (e.g. exactly one `restored`/`changed` event per
  toolset, not doubled).
- Add **new test — restore is /reload-safe** (the core regression):
  - Simulate a reload by creating a second `MockPI` (representing the new
    extension's fresh API) **without** clearing `globalThis` (i.e. do not
    call `cleanRegistry` between the two pis; only clear the
    `__piToolMaskingLastRestoreEvent` key if a prior test left it).
  - `defineToolset` the same spec on `pi2`, persist an `enabled: false`
    entry on `pi1`, then fire `session_start` on `pi2` and assert restore
    runs on `pi2` (tools disabled on `pi2`, `restored` event emitted with
    `pi2`'s event bus) — proving the stale boolean no longer blocks the
    fresh extension.
  - Add a sibling assertion: fire `session_start` a **second** time on
    `pi2` with a fresh event object and confirm restore runs again (fresh
    event → not deduped).

---

## Finding 2 (LOW) — Restore disable-branch inconsistent with `_applyDisable`

### Root cause

`_applyDisable` filters active tools by `spec.names.has(n)` (all spec
members). `_applyRestoreToolset`'s disable branch filters by
`registeredNames` (only registered tools). If a spec member is active but
unregistered, manual `disable` removes it; restore-disable leaves it. The
enable-side filter-to-registered is correct per §4.1 (can't activate an
unregistered tool), but disable should match `_applyDisable` per §9.

### Fix — `index.ts`

One-line change in `_applyRestoreToolset`'s `else` branch:

```ts
// before
const filtered = current.filter((n) => !registeredNames.includes(n));
// after
const filtered = current.filter((n) => !spec.names.has(n));
```

`registeredNames` is still needed for the enable branch; keep its
computation. (If a subsequent read shows `registeredNames` is then unused
in the disable path only, leave the declaration — it's used by enable.)

### Test — `__tests__/core.test.ts`

Add a test in the restore round-trip block: register a spec member, enable
it, then **unregister** it (or define a spec member that is never
registered), persist `enabled: false`, fire `session_start`, and assert the
active list no longer contains that name — matching `_applyDisable`
behavior. (Use a fresh `MockPI` helper or extend `MockPI` with an
`unregisterTool` if needed; prefer the never-registered variant to avoid
new mock surface.)

---

## Finding 3 (LOW) — "Cycle detection on disable" test doesn't call disable

### Root cause

The test is titled "throws on disable of a toolset in a reverse cycle" but
calls `tsA.enable(pi)`, exercising `_enableToolset`'s cycle branch, not
`_disableDependents`'s. The disable cycle branch is reachable: defining
A↔B and calling `tsA.disable(pi)` walks `_disableDependents` → disables B
→ recurses to A → `path.includes("A")` is true → throws
`"Cycle detected on disable: A → B → A"`.

### Fix — `__tests__/core.test.ts`

- Keep the existing enable-cycle test (rename its `it` to "throws on
  enable of a toolset in a cycle" for honesty).
- Add a new test: same A↔B cycle, call `tsA.disable(pi)`, assert it
  `toThrow("Cycle detected on disable")`. Note `_applyDisable(self)` runs
  before the throw (a side effect); the assertion is only on the throw,
  which is fine.

---

## Finding 4 (NIT) — Restore skips the requires cascade (by design)

### Fix — `index.ts`

Add a `// ponytail:` comment at the top of the restore loop in `doRestore`
naming the reliance, so a future reader doesn't "fix" it by cascading
restore and double-toggling:

```ts
// ponytail: restore applies each toolset's entry independently and does
// NOT re-run the requires cascade. Safe because §7.1 guarantees persisted
// state is always consistent — the live-toggling cascade (§4.4) makes an
// incoherent persisted combo unreachable. Re-adding cascade here would
// double-toggle and break restore independence.
```

No test, no behavior change.

---

## Finding 5 (NIT) — Path-tracking style split

No action. `_enableToolset` uses `path.push/pop`; `_disableDependents`
uses `[...path, id]`. Both correct; the asymmetry is cosmetic. Not worth
a diff unless that code is touched for another reason.

---

## Verification

1. `npx tsc --noEmit` — clean (no new types introduced; the only structural
   change is dropping one constant and adding one).
2. `npx vitest run` — all existing tests pass except the two intentionally
   updated/renamed ones (Finding 1 dedup test, Finding 3 cycle test), plus
   the new tests added for Findings 1, 2, 3.
3. Manually re-read `ensureRestoreHandler` after the change to confirm:
   - no `globalThis` boolean guard remains,
   - `doRestore` closes over the current `pi` (so a post-reload handler
     captures the fresh, non-stale `pi`),
   - the event-identity check is the first statement.

## Out of scope (per review "Observations")

- `masked`/`label`/`description` never read — correct per §5 (opaque
  pass-through for the deferred manager).
- `setDefaultResolutionMode`/`getDefaultResolutionMode` take an unused
  `pi` — matches the design signature.
- `package.json` exports point at `.ts` directly — intentional per
  Sprint 0.
