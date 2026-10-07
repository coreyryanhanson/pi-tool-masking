# AGENTS.md

## Repo shape

Single-file library (`index.ts`) published to npm as `pi-tool-masking`. No build
step — TypeScript is consumed directly (`noEmit: true`, `moduleResolution:
nodenext`; `exports`/`main`/`files` all point at `index.ts`). No linter or
formatter. `index.ts` is densely TSDoc'd, and `README.md` holds the full
behavioral contracts — grep the definition site before restating either.

## Commands

```bash
npm test            # vitest run (CI runs exactly this)
npm run test:watch  # vitest watch
npx tsc --noEmit    # typecheck — NOT a package script
npm run publish:dry # npm publish --access public --dry-run

npx vitest run __tests__/core.test.ts   # one file
npx vitest run -t "restore"             # one test-name pattern
```

`prepublishOnly` is `npm test && npx tsc --noEmit`, so typecheck only gates a
publish; CI also runs it. Run `tsc --noEmit` yourself before shipping. `tsconfig`
adds `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` on top of
`strict` — indexed access is `T | undefined`, optional props can't be set to
`undefined`.

## Tests

Vitest, globals on, `testTimeout: 15_000`. No external services, fixtures, or
snapshots. `__tests__/`:
- `core.test.ts`, `registry-convergence.test.ts`, `child-policy-defer.test.ts`,
  `drift.test.ts` — use the shared `helpers.ts` rig.
- `custom-entry.test.ts` — pure `lastCustomEntry` unit test, no rig.
- `mock-pi.ts` — `MockPI`, a subset of `ExtensionAPI`.

Rig (`helpers.ts`): `createEnv()` → `{ mock, pi }`; `reader(pi)` → `BranchReader`;
`cleanRegistry()` sweeps the globalThis keys plus `PI_TOOLMASKING_DEFER`;
`catchByName(fn)` exercises the copy-safe `err?.name` contract. Stateful suites
call `cleanRegistry()` in `beforeEach` (`cleanGlobalKeys()` when the defer env
var must survive). Registry, restore-event guard, and the invalid-childPolicy
warn flag are process-global — leakage between tests is a real failure mode.
`child-policy-defer.test.ts` saves/restores the defer env var around each test.
`drift.test.ts` calls `useTempSettingsDir()` at module scope (`computeDrift`
reads merged settings on every call) and hand-sets the defer env in a `finally`.

## CI & release

CI (`.github/workflows/test.yml`): `npm ci && npm test && npx tsc --noEmit` on
PRs and pushes to `main` (Node `lts/*`).

```bash
node scripts/release.mjs patch|minor|major|<x.y.z>   # npm run release:patch etc.
```

Requires a clean tree. Draft `[Unreleased]` `CHANGELOG.md` entries first (warns
but proceeds if empty). Runs `npm test`, bumps version, promotes `[Unreleased]`
to `[version] - date`, commits, tags `v<version>`, publishes (re-running test +
typecheck via `prepublishOnly`), reinstates `[Unreleased]`, commits, pushes
`main` + tag.

## Traps

Caller-facing first, internals last. Details in `README.md`.

- **Pass `ctx.sessionManager` itself** to `toggleBatch` / `Toolset.enable`/`.disable`
  — never a bare `getBranch` method reference (unbound → throws). Toggles are
  **exclusion-mode only**: under allowlist governance they throw
  `AllowlistModeError` before any write; actuate under focus with
  `forceToolsetEnabled` instead.
- **Catch `AllowlistModeError` / `CycleError` / `ContradictionError` /
  `PersistKeyCollisionError` by `err?.name`, never `instanceof`** — the
  `globalThis` registry lets multiple physical copies of the library coexist.
  `MalformedSettingsError` is the deliberate opposite (`instanceof` is safe).
- **One `toggleBatch` call is one coherent intent.** "Disable a dependency, then
  enable something requiring it" needs two calls. The result is a flattened delta
  (`[]` = silent no-op); emits fire only after all writes, in planner order. The
  pure planner refuses cycles/contradictions pre-write; an explicit unknown id
  throws, while implied unregistered `requires` deps are skipped.
- **`effectiveEnabled(...).enabled` is display-only — never a toggle pre-check.**
  It is mode-dependent (branch ledger under exclusion, `allowlist.includes` under
  allowlist). Call the toggle and catch instead. `getEffectiveDefault` ignores
  mode.
- **`getRegisteredToolsets()` entries are live.** `entry.spec.names = new
  Set(next)` is the runtime-membership mutation (data only — no actuate/persist/
  emit; `/reload` resets to the code spec). Never re-call `defineToolset` to
  change members.
- **`getActuatableNames(pi)` is the actuation boundary** and a documented
  *over*-approximation: it returns MCP tools the session's `--tools` gate still
  refuses. A toolset with zero actuatable members is *inert* — toggles
  persist/emit intent, `isEnabled()` (observation) stays false while
  `effectiveEnabled()` (intent) reports the recorded state. Pick the right signal.
- **`computeDrift` is defer-aware**, returning `[]` in a deferring child
  (masking's intent doesn't govern the live set there). The over-approximation
  above is its known false-positive class (an intent-on toolset holding a
  `--tools`-refused member reads as permanent force-removal) — verify repair
  writes, don't loop until clean.
- **`TOOLSET_EVENTS` type diverges by path.** Exclusion restore emits `restored`
  for a persisted entry but `changed` for a settings/packaged fallback; allowlist
  restore emits `restored` for every registered toolset; re-assert and
  `forceToolsetEnabled` always emit `changed`.
- **`defineToolset` is idempotent by `spec.id`**: deep-equal spec → same handle;
  same id + changed spec → warns and replaces (old handles die). Registration
  guards throw atomically: `PersistKeyCollisionError` on a `persistKey`
  collision, a plain `Error` on tool-name overlap (one toolset per tool) or the
  reserved `toolset-resolution-mode` persistKey.
- **Settings** (`toolsetDefaults`, `piToolMasking.childPolicy`): global
  `$PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent/settings.json`),
  project `<cwd>/.pi/settings.json`, project wins per entry; `childPolicy` is a
  scalar per scope (never spread-merge). Readers never throw (malformed → `{}`);
  writers throw `MalformedSettingsError`. Tests must use temp settings dirs
  (`useTempSettingsDir`), never the real `~/.pi`.
- **`__internal`** (`planBatch`, `executeBatchPlan`, `parseToolsetDefaults`) may
  change or vanish between any releases.
- **Registry lives on `globalThis`** (`__piToolMaskingRegistry`) to survive
  `/reload` across module instances; the invalid-childPolicy warn flag too. There
  is no module-state governance mirror — restore, resolver, re-assert, and the
  toggle refusal all read the branch via `readBranchModeState`.
- **Persistence** is `pi.appendEntry(persistKey, { enabled })` +
  `pi.sessionManager.getBranch()`. Restore re-runs on every
  `session_start`/`session_tree` (handler pair installed once per `pi` via
  WeakSet). A `null` tombstone falls through to the settings/packaged tier.
- **`before_agent_start` re-asserts each turn**: allowlist mode undoes both drift
  directions; exclusion mode removes force-re-added members of effectively-off
  toolsets (leak direction only). `changed` emits per actually-drifted toolset.
  **Residual:** it runs at this extension's load-order position, so a later
  force-add reconciler or pi core's `--tools` re-add can oscillate one write/side/
  turn. A real fix needs a pi-core `setActiveTools` masking primitive.
- **Toggle path:** `planBatch` (pure) → `executeBatchPlan`; `toggleBatch` wraps
  it, `Toolset.enable`/`.disable` delegate. The plan is the authority inside a
  call — the `before` state comes from the single branch read at the call
  boundary, no mid-call re-read (that would race the plan). Each public call
  re-reads at its own boundary, so cascades/loops stay correct.
- **Child-policy defer:** `piToolMasking.childPolicy` (`"defer"` default |
  `"settings"`). A defer-policy parent publishes `PI_TOOLMASKING_DEFER` (= own
  pid); a **foreign** pid no-ops restore and the per-turn re-assert entirely and
  leaves the var untouched (republishing own pid would flip the child back to
  enforcing). `"settings"` deletes the var. `isDeferredChild()` is env-only. In a
  deferring child, branch-governance writes are silent no-ops (toggles `[]`,
  `setDefaultResolutionMode` validate-then-suppress, tombstone helpers write
  nothing) while deliberate writes stay live (`forceToolsetEnabled`, raw
  `appendEntry`, settings writers). No `session_shutdown` cleanup (republish
  trap). Deferring children emit no mask events. Masking is context hygiene, not
  a security boundary.
