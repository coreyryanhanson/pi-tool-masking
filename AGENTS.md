# AGENTS.md

## Repo shape

Single-file library (`index.ts`) published to npm as `pi-tool-masking`. No
build step — TypeScript is consumed directly (`noEmit: true`,
`moduleResolution: nodenext`, `exports` and `main` point to `index.ts`,
`files` ships only `index.ts`). No linter or formatter scripts exist.

## Commands

```bash
npm test            # vitest run (CI runs exactly this)
npm run test:watch  # vitest watch
npx tsc --noEmit    # typecheck (not a package script; runs in prepublishOnly)
```

Single test file: `npx vitest run __tests__/core.test.ts`
By name pattern: `npx vitest run -t "restore"`

There is **no `typecheck` npm script**. `prepublishOnly` is
`npm test && npx tsc --noEmit`, so typecheck only gates a publish. Run
`tsc --noEmit` yourself before shipping — the strict tsconfig (see below)
catches things vitest won't.

## Strict TypeScript

`tsconfig.json` enables `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `isolatedModules`, `moduleDetection: force`, on
top of `strict`. Indexed access returns `T | undefined`; optional props can't
be set to `undefined` explicitly. Respect this in new code — typecheck will
fail otherwise.

## Tests

Vitest with **globals on** (`describe`/`it`/`expect` available without import;
`types: ["node", "vitest/globals"]`). `testTimeout: 15_000`.

Tests live in `__tests__/` (`core.test.ts`, `registry-convergence.test.ts`, `custom-entry.test.ts`,
`child-policy-defer.test.ts`, and shared `helpers.ts`).
They use a custom `MockPI` class (`__tests__/mock-pi.ts`) implementing a
subset of `ExtensionAPI` (`setActiveTools`, `getActiveTools`, `getAllTools`,
`registerTool`, `appendEntry`, `on`, `events`, `sessionManager.getBranch()`).
No external services, no fixtures, no snapshots. The child-policy-defer tests
must save/restore `process.env` and delete the `globalThis` registry keys and
the invalid-childPolicy warn-dedup flag in `beforeEach` — process-global state
is the feature under test, so leakage between tests there is a real failure
mode.

## CI

`.github/workflows/test.yml` runs `npm ci && npm test && npx tsc --noEmit`
on PRs and pushes to `main` (Node `lts/*`) — typecheck runs in CI too.

## Release

```bash
node scripts/release.mjs patch|minor|major|<x.y.z>
```

Requires a clean working tree. The script: runs `npm test`, bumps version
(`npm version --no-git-tag-version`), promotes `[Unreleased]` in
`CHANGELOG.md` to `[version] - date`, commits, tags `v<version>`,
`npm publish --access public`, reinstates a fresh `[Unreleased]` section,
commits that, and pushes `main` + the tag to `origin`. Draft `[Unreleased]`
entries in `CHANGELOG.md` before running (the script warns if empty but
proceeds).

## Key public API

| Export | Notes |
|---|---|
| `defineToolset(pi, spec)` | Idempotent re-registration by `spec.id` |
| `setDefaultResolutionMode(pi, mode, allowlist?)` | `"exclusion"` (default) or `"allowlist"` (requires `allowlist: string[]`). The governance authority switch — the branch append it writes is the only mode write; every governance decision reads the branch back. In a deferring child: validate-then-suppress (invalid input still throws; only the append is suppressed) |
| `getRegisteredToolsets()` | Pure registry read — no `pi` argument needed. The array is a copy but its entries are the live registry entries: `entry.spec.names = new Set(next)` is the runtime-membership mutation mechanism (data only — no actuation/persist/emit) |
| `effectiveEnabled(spec, branch, defaults)` | Resolve a toolset's persisted intent through the same tiers restore does: allowlist override (mode read from the passed `branch`) → chat-branch entry → settings pin → `defaultEnabled ?? true`. `defaults` is a `readMergedToolsetDefaults()` snapshot. Returns `{ enabled, persistedEntry }` — display surfaces read `.enabled` (mode-dependent by design: the ledger under exclusion, `allowlist.includes(spec.id)` under allowlist); never a toggle pre-check — call the toggle and catch. `persistedEntry` is true only when the last branch entry carries a boolean `enabled` (tombstones/absent → false) |
| `readBranchModeState(branch)` | Copy-on-read governance decision read — `{ mode, allowlist }` from the branch (absent entry → exclusion; corrupt allowlist fail-closed: non-array → `[]`, non-string members dropped), the same shared read restore, the resolver, the re-assert dispatcher, and the toggle refusal use. For decision/authoring paths only, **never** a toggle pre-check — call the toggle and catch. Copy-on-read both directions: the returned allowlist is a fresh array; `setDefaultResolutionMode` copies its input before `appendEntry` (pi stores entry `data` by reference) |
| `isDeferredChild()` | Env-only defer predicate (`PI_TOOLMASKING_DEFER` foreign-pid check, never settings) shared by the re-assert dispatcher, the toggle gate, and consumers' own actuation/authoring gates |
| `clearToolsetEntry(pi, persistKey, branch)` / `clearAllToolsetEntries(pi, branch)` | Write a null tombstone (single / all) so restore supersedes stale persisted state. Silent no-op in a deferring child (clearAll loops through clearToolsetEntry's gate) |
| `toggleBatch(pi, sessionManager, ops)` | The sole toggle actuation path — `Toolset.enable`/`.disable` are one-line single-op wrappers delegating here, so the two surfaces cannot diverge. `ops: { id, desired }[]`. Gate order (every refusal atomic): defer → empty `ops` → allowlist refusal → plan (cycle/contradiction/input validation) → settings snapshot → execute. Reads the branch once, at its own boundary; the plan is the intent authority inside the call (no mid-flight re-reads). Returns a flattened intent delta — one `ToggleResult` per id whose final state differs from the pre-call resolved state or whose loadout wrote; an op already in its desired state is absent. No library-emitted event fires until every write has completed; emits fire once, in the planner's discovery order. One batch = one coherent intent — an op set that disables a dependency while enabling something that requires it throws; a well-formed consumer partitions the registered toolsets against the desired-on closure (enable those, disable the rest), which is coherent by construction and expressible as one batch. Input semantics: explicit unknown id throws; implied unregistered closure deps leniently skipped; duplicate ops dedupe by `desired` value (conflicting values throw) |
| `Toolset.enable(pi, sessionManager)` / `.disable(pi, sessionManager)` | Single-op sugar over `toggleBatch` (delegating, not re-implemented — cannot diverge). Required branch reader (in practice `ctx.sessionManager` — pass the object, never a bare `getBranch` method reference); the library reads the branch once per call, at that call's boundary, so one reader per command covers cascades and loops (each wrapper call re-reads at its own boundary). Returns `ToggleResult[]` — one `{id, enabled}` entry per toolset whose resolved intent changed or whose loadout wrote (`enabled` = the value that call persisted and emitted; inert toolsets report on intent delta), `[]` on a silent no-op; persist + emit iff intent changes ∨ loadout write. No branchless fallback. **Gate order is part of the contract: defer → empty `ops` → allowlist refusal → plan → settings snapshot → execute** |
| `AllowlistModeError` | Thrown at the `toggleBatch` boundary under allowlist governance (the wrappers delegate to it) — before any write; atomic (no branch entry, no emit, no loadout write); a caught refusal means "refused, nothing changed". The refusal is mode-global: through the single-op wrappers `specId` is set (bit-identical to the historical contract); on the batch path it is absent (`undefined`) — a batch refusal attributes nothing, consumers render it from their own op list. Catch by `err?.name === "AllowlistModeError"`, never `instanceof` (handles come from the shared `globalThis` registry and may belong to another physical copy of the library). Deliberately unlike `MalformedSettingsError`'s `instanceof` contract, which is safe because its throwers are same-module-instance imports |
| `CycleError` / `ContradictionError` | Thrown by the planner (`planBatch`), pre-write and atomic — a cycle anywhere reachable from any op, or an incoherent resolved intent (an id enabled while a transitive `requires` dependency of it is disabled by the same batch; conflicting duplicate ops on one id are the zero-hop form). No winner-picking, no off-wins fallback; coherent explicit-beats-implied survives (`enable Y` + `disable Z`, Z requires Y → `{Y: true, Z: false}`). Catch by `err?.name` (`"CycleError"` / `"ContradictionError"`), same name-based contract as `AllowlistModeError`; messages are diagnostics, never string-matched. `CycleError` carries the path as `cyclePath` |
| `forceToolsetEnabled(pi, spec, enabled)` | Apply one toolset's state live without writing a branch entry (no cascade — call once per spec; used by tbox). Always applies and always emits; `void` by design — shares the restore path, so it can never honor the `ToggleResult[]` contract. The primary actuation path under allowlist governance; stays live in a deferring child |
| `readToolsetDefaults(scope)` / `readMergedToolsetDefaults()` | Read `toolsetDefaults` from one scope / merged global+project |
| `writeToolsetDefaults(entries, scope)` / `clearToolsetDefaults(scope)` | Mutate / clear `toolsetDefaults` settings |
| `getEffectiveDefault(spec, snapshot?)` | Resolve a toolset's effective default through the settings + packaged tiers (mode-agnostic — callers needing mode-aware behavior consult `readBranchModeState`) |
| `MalformedSettingsError` | Thrown by the settings writer on unparseable settings JSON (readers never throw) |
| `parseToolsetDefaults(json)` | Lenient parse of raw `toolsetDefaults` JSON (`@internal`; returns `{}` and drops invalid entries, never throws) |
| `lastCustomEntry<T>(branch, customType)` | Newest custom entry matching `customType`, narrowed through the `"custom"` discriminator so callers get typed `.data` without per-site `any` casts |
| `TOOLSET_EVENTS` | `changed`, `restored` |

`setSettingsOverrideForTests` / `setSettingsWriterOverrideForTests` are test seams, not public API.

## Architecture notes

- Registry lives on `globalThis` (`__piToolMaskingRegistry`) — survives
  `/reload` across module instances. The invalid-childPolicy warn-dedup
  flag is also on `globalThis`. There is no module-state governance copy:
  every governance decision (restore, resolver, re-assert dispatcher, the
  toggle refusal) reads the branch via `readBranchModeState`.
- Persistence via `pi.appendEntry(persistKey, { enabled })` and
  `pi.sessionManager.getBranch()`. Restore triggers on `session_start` and
  `session_tree`; a per-event guard dedupes repeated restore events.
- `before_agent_start` re-asserts the active mode's mask each turn; arm
  selection reads the branch (`readBranchModeState(ctx.sessionManager
  .getBranch())` — the same shared read as restore, the resolver, and the
  toggle refusal; no module-state mirror exists).
  In allowlist mode it undoes BOTH directions of mid-session drift by
  other extensions' reconcilers that bypass the mask via
  `pi.setActiveTools` between restore events:
  force-adds of non-allowlisted tools are removed and force-removals of
  allowlisted members are restored. In exclusion mode it removes
  force-re-added tools of toolsets whose effective state is off (leak
  direction only, same tier chain as restore). Emits `changed` for each affected
  toolset; delta-gated to no-op when nothing drifted. The mask is computed
  from a single shared helper (`computeAllowlistDesired`) with the session
  restore path so the two never drift. Restore/re-assert handlers install
  once per `pi` instance (WeakSet guard) rather than once per toolset.
  Residual: runs at this extension's load-order position — a
  force-add reconciler on a later-loading extension re-adds after us, and
  pi core itself re-adds every `--tools`/`allowedToolNames` name on every
  tool-registry refresh (per-`registerTool` since pi 0.99 — see pi's
  `_refreshToolRegistry`), so a forced name that is also a member of
  an off/suppressed toolset oscillates — pi re-adds at refresh, the
  re-assert removes at the next `before_agent_start` — bounded at one
  write per side per turn. A fully-robust fix needs a pi-core masking
  primitive at the `setActiveTools` boundary.
- `requires` cascade: enable cascades to deps, disable cascades to
  dependents. Cycle detection and contradiction refusal happen in the
  pure planner, before any write or emit (`CycleError` carries the path
  as `cyclePath`; `ContradictionError` fires when an id would end up
  enabled while a transitive `requires` dependency of it is disabled by
  the same batch — conflicting duplicate ops on one id are its zero-hop
  form).
- **Toggle path (delta gate):** one toggle path exists — the batch
  planner/executor (`planBatch` → `executeBatchPlan`, wrapped by
  `toggleBatch`); `Toolset.enable`/`.disable` delegate to it. The intent
  source for a call is the pre-computed `plan.intent`; the pre-call state
  (`before`) resolves from the ONE branch value read at the call's
  boundary (`sessionManager.getBranch()` — no cached intent state, and
  direct external writes before the call are visible to it by
  construction, which is what fixes the witnessed-off clobber drop), and
  the settings tier from one `readMergedToolsetDefaults()` snapshot taken
  after planning (never re-read per apply). No fresh re-read exists
  mid-call: inside a call the plan is the authority, and loop correctness
  survives because each public call re-reads at its own boundary. Do not
  "restore" a per-apply fresh read — the emit-after-execution design
  makes it both unnecessary (no library event fires mid-batch, so no
  library-event listener can race the batch) and wrong (a mid-call
  re-read would race the plan). Same-value toggles are silent no-ops
  returning `[]`; every toggle call site passes the reader — no
  branchless convention exists (empty branch = no intent recorded, a
  legitimate session state, not a fallback). Cascade silence (e.g. a
  `requires` diamond applying to the same toolset twice) is structural:
  the planner's global visited set makes `plan.order` contain each id
  exactly once, so the skip is always correct.
- **Allowlist boundary: toggles are an exclusion-mode operation.** At the
  top of `toggleBatch` (and thus of the delegating wrappers) — after the
  defer and empty-`ops` gates, before planning and the settings snapshot —
  the branch mode is read via `readBranchModeState(sessionManager
  .getBranch())`; under allowlist governance every toggle throws
  `AllowlistModeError` (atomic: nothing precedes the throw; the refusal
  is mode-global — no `specId` on the batch path). There is no
  coherent/incoherent taxonomy, no shadowed-enable forwarding, no
  per-apply check — under allowlist governance the toggle API does not
  operate; convergence after a refusal is the per-turn re-assert's job,
  and immediate actuation under focus is `forceToolsetEnabled`'s. Gate
  order is part of the contract: a deferring child (see the defer note)
  returns `[]` before the mode check — as does an empty `ops` array, in
  every governance mode (an empty batch requests nothing) — so a
  deferring child in allowlist mode noops rather than throwing. The delta
  gate above runs only under exclusion governance — the toggle path's
  silence and `ToggleResult[]` guarantees are exclusion-mode contracts.
  The read side stays mode-dependent by design: `effectiveEnabled().enabled`
  answers the branch ledger under exclusion and `allowlist.includes(spec.id)`
  under allowlist (an accepted, documented residual — never unified, since
  unifying would let stale ledger entries override the focus set).
- **Subagent inheritance (child-policy defer):** `piToolMasking.childPolicy`
  in settings (`"defer" | "settings"`, default `"defer"`, project wins per
  scope, scalar read — never spread-merge) controls behavior in spawned
  child sessions. At the top of `doRestore` (before the allowlist
  short-circuit) the process reads the policy and manages
  `PI_TOOLMASKING_DEFER` (value = publisher pid, a static tag, no per-
  toolset payload): defer policy + absent var → publish; defer policy +
  foreign var → skip the ENTIRE restore (both tiers — branch entries must
  not apply either) and leave the var untouched (no republish — overwriting
  with own pid would flip the child to enforcing at its next same-process
  restore: session_tree, /new, /resume); `"settings"` → delete the var and
  mask normally (subtree-effective). The `before_agent_start` dispatcher
  checks the foreign-var condition (foreign-var only, not presence-only —
  the parent must keep its own re-assert) before both re-assert paths.
  The exported `isDeferredChild()` is the same env-only predicate; every
  public API that implicitly writes branch governance state is a silent
  no-op in a deferring child (every toggle returns `[]` before the mode
  check — the wrappers via `toggleBatch`'s defer gate,
  `setDefaultResolutionMode` is validate-then-suppress — input validation
  still throws, only the append is suppressed —
  `clearToolsetEntry`/`clearAllToolsetEntries` write nothing), while
  deliberate write/actuation APIs stay live (`forceToolsetEnabled`, raw
  `appendEntry`, the settings writers — the settings tier is outside the
  traceability rule). The noops are fully silent (no notify —
  `ExtensionAPI` has no notify channel; documented behavior, not a
  softened one). No per-`tool_call` work, no delta gating, and
  deliberately no `session_shutdown` cleanup (deleting the var at shutdown
  would flip a deferring child to enforcing at its next restore — the
  republish trap; pid recycling fails safe). Deferring children emit no
  mask events.
