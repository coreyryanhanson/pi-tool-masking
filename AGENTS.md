# AGENTS.md

## Repo shape

Single-file library (`index.ts`) published to npm as `pi-tool-masking`. No
build step — TypeScript is consumed directly (`noEmit: true`,
`moduleResolution: nodenext`, `exports`/`main` point at `index.ts`, `files`
ships only `index.ts`). No linter or formatter. Full behavioral contracts live
in `README.md`; read it before changing the public API.

## Commands

```bash
npm test            # vitest run (CI runs exactly this)
npm run test:watch  # vitest watch
npx tsc --noEmit    # typecheck — NOT a package script

npx vitest run __tests__/core.test.ts   # one file
npx vitest run -t "restore"             # one test-name pattern
```

`prepublishOnly` is `npm test && npx tsc --noEmit`, so typecheck only gates a
publish; CI also runs it. Run `tsc --noEmit` yourself before shipping.

## Strict TypeScript

`tsconfig.json` adds `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`isolatedModules`, `noUncheckedSideEffectImports`, `moduleDetection: force` on
top of `strict`. Indexed access is `T | undefined`; optional props can't be set
to `undefined`. Typecheck fails otherwise.

## Tests

Vitest, globals on, `testTimeout: 15_000`. No external services, fixtures, or
snapshots. `__tests__/`:
- `core.test.ts`, `registry-convergence.test.ts`, `child-policy-defer.test.ts` —
  use the shared `helpers.ts` rig.
- `custom-entry.test.ts` — pure `lastCustomEntry` unit test, no rig.
- `mock-pi.ts` — `MockPI`, a subset of `ExtensionAPI`.

Rig (`helpers.ts`): `createEnv()` → `{ mock, pi }`; `reader(pi)` → `BranchReader`;
`cleanRegistry()` sweeps the globalThis keys plus `PI_TOOLMASKING_DEFER`;
`catchByName(fn)` exercises the copy-safe `err?.name` contract. Stateful suites
call `cleanRegistry()` in `beforeEach` (`cleanGlobalKeys()` when the defer env
var must survive). Registry, restore-event guard, and the invalid-childPolicy
warn flag are process-global — leakage between tests is a real failure mode.
`child-policy-defer.test.ts` saves/restores `process.env["PI_TOOLMASKING_DEFER"]`
in `beforeEach`/`afterEach`.

## CI

`.github/workflows/test.yml`: `npm ci && npm test && npx tsc --noEmit` on PRs
and pushes to `main` (Node `lts/*`).

## Release

```bash
node scripts/release.mjs patch|minor|major|<x.y.z>
```

Requires a clean tree. Runs `npm test`, bumps version, promotes `[Unreleased]`
in `CHANGELOG.md` to `[version] - date`, commits, tags `v<version>`,
`npm publish --access public`, reinstates `[Unreleased]`, commits, pushes `main`
+ tag. Draft `[Unreleased]` entries first (warns but proceeds if empty).

## API traps

Not a full API reference — see `README.md`.

- `defineToolset(pi, spec)` is idempotent by `spec.id`: deep-equal spec → same
  handle; same id + changed spec → warns and replaces (old handles die).
  Registration guards throw atomically: `PersistKeyCollisionError` when another
  toolset claims the `persistKey`; plain `Error` on tool-name overlap (each tool
  belongs to one toolset) and on the reserved `toolset-resolution-mode`
  persistKey. Ids are namespaced `<product-family>.<subset>`.
- Toggles (`toggleBatch`, `Toolset.enable`/`.disable`) take a `BranchReader` —
  pass `ctx.sessionManager` itself, never a bare `getBranch` method reference
  (unbound → throws). They are **exclusion-mode only**: under allowlist
  governance they throw `AllowlistModeError` before any write. Actuation under
  focus is `forceToolsetEnabled`. Gate order: defer →
  empty `ops` → allowlist refusal → plan → settings snapshot → execute. The pure
  planner refuses cycles (`CycleError.cyclePath`) and incoherent intents
  (`ContradictionError`) atomically, pre-write; an explicit unknown id throws,
  implied unregistered `requires` deps are skipped.
- `toggleBatch` returns a flattened intent delta (`ToggleResult[]`; `[]` = silent
  no-op). One batch = one coherent intent — "disable a dependency then enable
  something requiring it" needs two calls. Emits fire only after all writes, in
  planner order.
- `requires` cascades: enable pulls deps on, disable pulls dependents off. The
  planner's visited set makes `plan.order` unique, so cascade repeats are silent.
- `setDefaultResolutionMode` is the only mode write; every governance decision
  reads the branch back via `readBranchModeState` (copy-on-read; corrupt
  allowlist fails closed: non-array → `[]`, non-string members dropped). The
  writer copies its input before `appendEntry` (pi stores `data` by reference).
  In a deferring child it is validate-then-suppress.
- `effectiveEnabled(...).enabled` is mode-dependent (branch ledger under
  exclusion, `allowlist.includes(id)` under allowlist) — display only, never a
  toggle pre-check. Tiers: allowlist → chat-branch entry → settings pin →
  `defaultEnabled ?? true`. `persistedEntry` is true only for a boolean `enabled`
  entry (tombstone/absent → false). `getEffectiveDefault` ignores mode.
- `getRegisteredToolsets()` entries are **live**: `entry.spec.names = new
  Set(next)` is the runtime-membership mutation (data only — no
  actuate/persist/emit; `/reload` resets to the code spec). Never re-call
  `defineToolset` to change members.
- Catch `AllowlistModeError` / `CycleError` / `ContradictionError` /
  `PersistKeyCollisionError` by `err?.name`, **never `instanceof`** (cross-copy
  via the `globalThis` registry). `MalformedSettingsError` is the deliberate
  opposite — `instanceof` is safe there.
- `forceToolsetEnabled(pi, spec, enabled)` always applies and always emits,
  persists nothing, no cascade — call once per spec. Primary actuation under
  allowlist; stays live in a deferring child.
- Settings (`toolsetDefaults`, `piToolMasking.childPolicy`): global
  `$PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent/settings.json`),
  project `<cwd>/.pi/settings.json`, project wins per entry; `childPolicy` is a
  scalar per scope (never spread-merge). Readers never throw (malformed → `{}`);
  writers throw `MalformedSettingsError`. Test seams live under `__internal`
  (`__internal.setSettingsOverrideForTests` / `__internal.setSettingsWriterOverrideForTests`)
  — test-only, may change or vanish between any releases; downstream suites use
  them at their own risk.
- `TOOLSET_EVENTS`: `changed` / `restored`. Type diverges by path — exclusion
  restore emits `restored` for a persisted entry but `changed` for a
  settings/packaged fallback; allowlist restore emits `restored` for every
  registered toolset; re-assert and `forceToolsetEnabled` always emit `changed`.

## Architecture notes

- Registry lives on `globalThis` (`__piToolMaskingRegistry`) so it survives
  `/reload` across module instances. The invalid-childPolicy warn flag is also
  on `globalThis`. No module-state governance mirror: restore, resolver,
  re-assert dispatcher, and the toggle refusal all read the branch via
  `readBranchModeState`.
- Persistence: `pi.appendEntry(persistKey, { enabled })` +
  `pi.sessionManager.getBranch()`. Restore runs on `session_start`/`session_tree`
  (per-event guard dedupes). A `null` tombstone falls through to the
  settings/packaged tier.
- `before_agent_start` re-asserts each turn, arm chosen from the branch:
  allowlist mode undoes both drift directions (removes non-allowlisted
  force-adds, restores force-removed allowlisted members); exclusion mode removes
  force-re-added members of effectively-off toolsets (leak direction only).
  `changed` is emitted per actually-drifted toolset, no-op when nothing drifted.
  The mask shares `computeAllowlistDesired` with restore; handlers install once
  per `pi` (WeakSet). **Residual:** runs at this extension's load-order position —
  a later-loading force-add reconciler re-adds after us, and pi core re-adds
  `--tools` names on every registry refresh, so a forced name in an off toolset
  oscillates (bounded one write/side/turn). A robust fix needs a pi-core
  `setActiveTools` masking primitive.
- **Actuatable members only:** loadout writes and masks filter through
  `getActuatableNames(pi)`; a `hidden`-exposure tool can never be active and is
  never handed to `setActiveTools` (older pi without `exposure`: all names
  actuatable). A toolset
  with zero actuatable members is *inert*: toggles persist/emit intent but
  `isEnabled()` (observation) stays false while `effectiveEnabled()` (intent)
  reports the recorded state — pick the right signal.
- **Toggle path:** `planBatch` (pure) → `executeBatchPlan`; `toggleBatch` wraps
  it and `Toolset.enable`/`.disable` delegate. The plan is the intent authority
  inside a call; the pre-call `before` state resolves from the single branch read
  at the boundary. No mid-call re-read — adding one would race the plan. Each
  public call re-reads at its own boundary, so cascades/loops stay correct.
- **Child-policy defer:** `piToolMasking.childPolicy` (`"defer"` default |
  `"settings"`). At the top of `doRestore`, a defer-policy parent publishes
  `PI_TOOLMASKING_DEFER` (= own pid); a **foreign** pid makes restore and the
  per-turn re-assert no-op entirely (both tiers) and leaves the var untouched —
  republishing own pid would flip the child to enforcing at its next same-process
  restore. `"settings"` deletes the var and masks normally. `isDeferredChild()`
  is the env-only predicate. In a deferring child, branch-governance writes are
  silent no-ops (toggles `[]`, `setDefaultResolutionMode` validate-then-suppress,
  tombstone helpers write nothing) while deliberate write/actuation stays live
  (`forceToolsetEnabled`, raw `appendEntry`, settings writers). No
  `session_shutdown` cleanup (republish trap). Deferring children emit no mask
  events. Masking is context hygiene, not a security boundary.
