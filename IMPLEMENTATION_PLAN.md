# Implementation Plan — pi-tool-masking 2.0.0

One behavioural fix — toolsets containing `hidden`-exposure tools
behave consistently — plus the allowlist-aware `effectiveEnabled` export,
a documentation-only fix for runtime membership change, and the removal of
the long-deprecated `inclusion` resolution mode (§3 — the breaking change
that makes this 2.0.0). The `hidden` fix changes behaviour on two different footings: the
exposure filter itself is latent for the library's consumers — not because
hidden members are hypothetical, but because no known consumer reaches them.
`hidden` has three live sources: it is a first-class `mcp.json` exposure,
accepted at server level or as a `toolExposure` override
(`core/mcp-servers.ts:18-37`, returned by `getMcpToolExposure` at
`:141-149` and passed through at `extensions/mcp/index.ts:262`); pi's `/mcp`
disable and remove paths re-register a server's whole tool list as `hidden`
mid-session (`extensions/mcp/index.ts:283-287`, invoked at `:492` and
`:869`); and tools a server drops are re-registered as `hidden`
(`extensions/mcp/index.ts:272-277`). No known consumer scopes toolsets to
whole servers, though, so none of these paths reaches a toolset member
today. The witness gates, by contrast, are reachable today — toggles on
*partially-registered* toolsets, a supported pattern the suite itself
exercises, now persist intent and emit instead of silently no-oping
(§2, §Compatibility).

**This file is the source of truth for the new contract** (one behavioural
fix, one new export, one breaking removal, docs-only Gap 1). `pi-tbox`
depends on it; see `pi-tbox/IMPLEMENTATION_PLAN.md`.

## Why

Pi 0.99.0 added `exposure` (`direct | model-only | codemode | deferred | hidden`),
MCP servers whose tools are registered after `session_start`, and
`prepareLoadout`. Auditing the library against those changes:

- Masking's machinery is **not** obsoleted. 0.99.0 adds two orthogonal axes
  (declaration visibility via `hiddenDeclarations`, callability via `exposure` —
  which also gates activation-on-registration through `defaultActive`);
  the registry, cascade, branch persistence, settings tier, focus/allowlist mode,
  turn-boundary re-assert and child-defer all have no native equivalent.
  `setActiveTools` remains the declared-set primitive.
- Two real gaps exist, both hit by dynamic consumer membership. A third
  change in this release is not 0.99-driven: the `inclusion` resolution
  mode, deprecated since 1.2.0, is removed outright (§3) — its deprecation
  window has outlived every consumer that ever set it.

### Gap 1 — runtime membership change is possible but undocumented

A consumer whose member set changes at runtime (an MCP server gaining or
losing tools) cannot re-`defineToolset`: same `id`, different spec is treated
as a code edit after `/reload` — it `console.warn`s and replaces the registry
entry, invalidating any handle it holds.

Raw mutation is the blessed path and already works: `getRegisteredToolsets()`
returns live registry entries, so `entry.spec.names = next` is the mechanism.
The JSDoc on that function (`index.ts:978-984`) is **incomplete, not false** —
every sentence in it is literally true (the returned array *is* a copy,
`index.ts:986`, so the registry can't be corrupted *through the array*), but it
documents only that shallow defense and is silent on the part that matters:
each element is the live registry entry, so mutation through an element
reaches the registry. The gap is
documentation, not API: this release corrects the JSDoc and the README, states
the mutation contract and its caveats (§1), and pins the liveness property
with one regression test. A guarded `setMembers` method was considered and
deferred — see §1's rejected alternatives.

### Gap 2 — `hidden`-exposure members make a toolset permanently "off"

`setActiveTools` ignores `hidden` tools, and they are excluded from the callable
set. So for a toolset containing a `hidden`-exposure tool:

- `_applyEnable`'s early return `registeredNames.every(n => current.has(n))` is
  never satisfied (the hidden member can never be active), so every `enable()`
  re-appends a no-op branch entry — under the fix this re-append is *retained
  by design* (§2 replaces the early return with a witness gate that still
  tests the registered set, so intent persists); what disappears is the no-op
  loadout write;
- `isEnabled` reports false for a toolset whose members are all hidden. This is
  correct and stays that way: pi's active set never contains a hidden name
  (enforced by `_applyToolLoadout`'s filter, `agent-session.ts:1501-1505`;
  the active set has a single writer, `this.agent.state.tools = declared`, at
  `:1543`), so a hidden member can never witness "on";
- the focus/allowlist mask force-adds the hidden name on every pass.
  `computeAllowlistDesired` filters its result only by registration
  (`index.ts:194`), but pi's `setActiveTools` silently drops `hidden` names
  (`agent-session.ts:1504`), so a hidden member is always "desired but not
  active": `reassertAllowlist`'s delta gate never short-circuits, and the
  library issues a redundant `setActiveTools` (full loadout + system-prompt
  rebuild in pi) plus a spurious `changed {enabled: true}` once per turn,
  forever — the same failure class the emit loop already avoids for
  unregistered names (`index.ts:484-496`).

### Gap 3 — the `inclusion` deprecation has run its course

`inclusion` (all unknown toolsets default off) has been deprecated since
1.2.0 with a one-time runtime warning whose own text promises removal "in a
coming 1.x minor" — a promise many times over due. No consumer source sets
it: `pi-tbox` only ever sets `"allowlist"` and `"exclusion"`
(`src/focus.ts:146, :229, :278`), and `pi-lean-host`'s tests seed
`"allowlist"` module state directly, their only references to the mode being
comments explaining they avoid it. No usage exists outside source either —
verified: the only `inclusion` strings in `pi-tbox` are its CHANGELOG and
IMPLEMENTATION_PLAN (the mode is discussed, never set), and
`__tests__/registry-per-source.test.ts` imports only
`getRegisteredToolsets`, driving its assertions through its own
enable/disable loop over an allowlist set, not through the mode. The
removal is therefore a no-op for every consumer in fact, not just in
intent — there is no consumer-side edit to make.

The removal pays for itself in the same release that exports
`effectiveEnabled`: the mode floor (`inclusion → false`, `index.ts:241`) is
that resolver's only mode-dependent line, so deleting inclusion deletes the
resolver's `mode` parameter and the inclusion floor — its last tier-chain
branch — leaving `getEffectiveDefault`
(settings → packaged default) and `effectiveEnabled` (plus chat-branch
entries) differing on exactly one axis instead of two. It also deletes the `warnInclusionDeprecation` machinery outright — both of
its callers go with the mode — along with the `@deprecated` JSDoc on the
type and setter.

## Contract

### 1. Runtime membership change — documented raw mutation, no new API

The contract for changing a toolset's members after registration, stated here
because `pi-tbox` depends on it. There is no new method; the consumer mutates
the live registry entry directly:

```ts
const entry = getRegisteredToolsets().find((t) => t.spec.id === "my-tools");
entry.spec.names = new Set(nextNames); // entries are live; this IS the mechanism
```

The contract is **scoped to consumers that are the toolset's membership
authority** — dynamically-managed toolsets whose spec exists only at runtime
(tbox's per-server/per-source ones are the intended users). A declared
toolset's authority is its spec literal in source: mutating its `names`
drifts from that source, and the next `/reload` re-runs `defineToolset` with
the fresh literal, warn-and-replacing the mutation (same
`console.warn` + registry replace as Gap 1). Declared toolsets change
members by changing their code and re-registering.

All of the following is load-bearing for tbox:

1. **Assigning `entry.spec.names` mutates the registered spec in place.** `id`
   and `persistKey` are unchanged and the same `ToolsetImpl` instance stays in
   the registry, so handles the consumer already holds keep working, no
   warn-and-replace fires, and persisted on/off state is unaffected. (This
   path avoids re-`defineToolset` entirely — no replace, hence no stale
   handles.)
2. **No actuate, persist, or emit.** Membership is data; actuation is a
   separate decision. Rationale:
   - The motivating case is pi-managed membership. When an MCP server gains a
     `direct` tool, pi activates it on registration; when it loses one, pi
     re-registers it `hidden`. The set therefore already matches the desired
     activation, so actuating would be a no-op.
   - A disabled toolset's newly-added members are removed by the existing
     `before_agent_start` re-assert, which reads the (now updated) `spec.names`.
   - Callers that want an immediate reconcile already have
     `applyToolsetEnabled(pi, spec, desired)` (exported, applies without writing a
     branch entry).
   - **Why silence here and not in §2.** The §2 emit rationale ("suppressing
     the emit would leave consumers with no signal at all") covers state
     changes a consumer did not initiate — restore, the per-turn re-assert,
     the cascade. The mutation is always caller-initiated: the caller knows it
     just changed membership and re-renders itself, so there is no uninformed
     party to inform. What is genuinely lost is the *second-order* consumer —
     another extension presenting the member set never learns it changed, and
     nothing else ever announces membership: restore replays enabled state
     only, and the `changed` payload (`{enabled}`) has no slot for a membership
     delta (a dedicated `membersChanged` event type is out of scope, see
     §Scope). That hole is a documented limitation, not an
     oversight: consumers other than the caller that present membership must
     re-read it via `getRegisteredToolsets()` instead of caching it (tbox
     looks handles up by id and re-derives members on every scan).
   - **Caveat — members pi does not activate on registration.** The first
     bullet covers only pi-activated members. Activation on registration is
     `_isDeclarable(exposure) && defaultActive !== false`
     (`agent-session.ts:3511-3518`), so a member that is either not declarable
     (`codemode`/`deferred`/`hidden`) or sets `defaultActive: false` (codemode
     and `tool_search` register theirs this way —
     `extensions/codemode/index.ts:41`, `extensions/tool-search/index.ts:14`)
     is NOT activated at registration: adding one to an *on* toolset leaves it
     undeclared with no event and no self-heal — the re-assert only defends
     the leak direction and never force-adds (`index.ts:513-560`), and the
     restore union runs only on restore events — while `isEnabled()` still
     reports true. Consumers adding such members to an enabled toolset must
     call `applyToolsetEnabled` themselves. Symmetrically, removing a name
     does not deactivate it: an on toolset can keep declaring a tool it no
     longer owns until pi itself de-registers or re-hides the tool. That
     correction is real but unobservable from an extension: a mid-session
     tool-list change arrives as the MCP notification
     `notifications/tools/list_changed` (`extensions/mcp/runtime.ts:375-376`),
     and pi's re-derivation of the registry on every `registerTool`
     (`core/extensions/loader.ts:299`) is what re-hides the lost tool — no
     extension event fires, and `mcp_servers_change` specifically never does:
     it reports only `registerMcpServer`/`unregisterMcpServer` calls
     (`core/extensions/runner.ts:457-460`), and mcp.json servers do not go
     through that API at all (`extensions/mcp/index.ts:791-802` loads the
     config directly). A later `disable()` cannot help either, because
     `_applyDisable`'s removal filter reads the now-updated `spec.names`,
     which no longer contains the orphaned name. The motivating MCP case is safe
     because tbox scopes members to
     declarable exposures (`direct`/`model-only`), which pi activates on
     registration — note MCP's *default* exposure is `codemode`
     (`core/mcp-servers.ts:148`), so a toolset over a whole server's tools
     would include non-activating members and hit this caveat. The README
     states both edges. (The mutation stays non-actuating: membership is
     data; actuation is a separate decision.)
3. **No overlap guard runs.** `defineToolset`'s name-overlap check fires only
   at registration; raw mutation bypasses it. With a single runtime writer
   this is discipline, not mechanism: tbox enforces disjointness by
   construction (orphan tools are filtered against already-claimed names and
   grouped by source — a tool cannot land in two sets). Assign a **fresh
   `Set`** and never keep mutating a set after assigning it — there is no
   copy-on-store, so a retained live reference bypasses even the discipline.
   If a second runtime writer ever appears, promote to a guarded
   `setMembers` method (additive; see the rejected alternatives).
4. **`/reload` resets membership to the code-defined spec.** The consumer's
   next scan re-derives and re-applies runtime membership (tbox does);
   persisted on/off state survives, membership does not. This is correct
   behaviour — and because the raw path never re-`defineToolset`s, no registry
   replace happens and no handle goes stale.
5. **An emptied toolset has dead toggles.** Assigning an empty `Set` is
   permitted, but `enable()`/`disable()` on a zero-member toolset are complete
   no-ops — the witness gate is vacuously satisfied, so no entry is written
   and no event fires (§2; pinned by the "Toolset with empty names" test). A
   new "off" therefore cannot be recorded while empty: disable before
   emptying (or after refilling). A prior branch entry survives emptying —
   intent resolution reads `spec.id`, not members — and repopulating revives
   actuation from whatever intent is persisted, so emptiness is temporary,
   not terminal.

Tests: one regression test (in `__tests__/registry-convergence.test.ts`)
pinning that `getRegisteredToolsets()` entries are live (mutate
`entry.spec.names`, re-fetch via `getRegisteredToolsets()`, observe the
change, and confirm the same `ToolsetImpl` instance is still registered) —
the documented mechanism depends on this property; everything else in this
section is behaviour that already exists.

Rejected and deferred alternatives:
- Softening `defineToolset` to silently update on a names-only change. It
  would remove the reload-after-edit diagnostic for every consumer, and it
  hides intent — raw mutation is explicit at the call site.
- `Toolset.setMembers(pi, names)` — a guarded method (re-run overlap guard,
  store a copy of the caller's `Set`, candidate → guard → assign). Deferred,
  not rejected: it earns its keep when membership change has a second runtime
  writer or the guard stops being enforceable by consumer discipline. Today
  exactly one consumer (tbox) mutates membership at runtime and it cannot
  produce an overlap, so the method would mechanize an invariant nothing
  stresses. The method is additive, so promoting it later is free.

### 2. `hidden`-exposure fix

Rewrite the existing `getRegisteredNames` helper **in place** rather than
adding a new one. It has exactly five call sites (`index.ts:387, :467, :608,
:651, :688`), and four of the five want the filtered set — so a
rename-and-rewrite is the entire reroute for those, and because both
`computeAllowlistDesired` feeds read the same helper, the restore/re-assert
never-drift invariant the mask comment promises (`index.ts:167-172`) becomes
structural instead of documented. The fifth call site (`_applyEnable`) needs
the unfiltered set too and is handled separately below (verified by grep;
the removal paths deliberately use raw `spec.names`, not this helper).

```ts
/** Registered tool names pi can actuate: present in the registry and not
 *  `hidden`-exposure. One getAllTools() pass — same cost as before. */
function getActuatableNames(pi: ExtensionAPI): Set<string>;
```

- A name is non-actuatable when it is unregistered, or its `exposure` is
  `"hidden"`.
- **Implementation note — one scan, not two.** The rewrite *replaces* the body
  of `getRegisteredNames` (one `getAllTools()` pass that simultaneously
  collects registered names and reads exposure) — the per-call tool-scan cost
  is unchanged for every rerouted site. Stacking a second scan on top would
  double it.
- **Capability detection:** if the `exposure` field is absent at runtime (pre-0.99
  pi, whose `ToolInfo` has no such field), treat the name as actuatable — i.e.
  exactly today's behaviour. Read it defensively (`(tool as { exposure?:
  string }).exposure`) and **keep the cast even with the `^0.99.1`
  devDependency** (step 5): this library ships raw TS source (no build, no
  `.d.ts`), so every consumer's `tsc` compiles `index.ts` against *their*
  installed pi types — and `pi-lean-dimension` still pins `^0.84.4`, where a
  plain `tool.exposure` read is a compile error (TS2339). The cast compiles
  against both generations, so the runtime tolerance for pre-0.99 pi is
  matched by compile-time tolerance; dropping the cast would silently impose
  a minimum pi *types* version on every consumer.

Sites that switch by the rewrite, with no per-site edits:

- **The focus/allowlist mask input.** `computeAllowlistDesired`'s `registered`
  parameter is fed from this helper at exactly two call sites — the restore
  allowlist branch (`index.ts:387`) and `reassertAllowlist` (`index.ts:467`).
  Hidden names leave `next` on every pass, so `reassertAllowlist`'s delta gate
  short-circuits again and the redundant per-turn `setActiveTools` (full
  loadout + system-prompt rebuild in pi) plus spurious `changed {enabled:
  true}` from Gap 2 disappear. The mask definition is unchanged — only the
  name source fed to it changes — and since both feeds read one helper, they
  cannot drift.
- `_emitToolsetEvents` member fanout (`index.ts:608`) — skip non-actuatable
  names in the per-member loop, the same failure class the emit loop already
  avoids for unregistered names (`index.ts:484-496`).
- **`_applyRestoreToolset`'s enable branch** (`index.ts:691-694`) — restore
  replays persisted state by unioning the registered-filtered `spec.names`
  into the active set, making it the fourth `spec.names`→actuation path. It is
  one-shot per restore event and nothing downstream compares the requested set
  to the applied one, so feeding it a hidden name is benign today — but it is
  the same shape (raw spec names handed to `setActiveTools`, silently dropped
  by pi), and the moment someone adds a delta gate here (the same optimisation
  `reassertAllowlist` already has), the identical churn bug reappears at a new
  site. Fold it in now so every actuation path shares one rule — fixing the
  class, not only the instance that currently misbehaves. While touching this
  line, an `if (toAdd.length)` guard also skips the redundant full-loadout
  write + system-prompt rebuild when `next === current` (optional, same
  commit).

The exception is `_applyEnable` (`index.ts:649-660`), which needs **both**
sets — and an early return that can no longer be observation-only (see the
inert-toolset contract below for why). It cannot reuse `getActuatableNames`
(which returns only the filtered set), so it runs its own single
`getAllTools()` pass collecting both (explicit-toggle path, not per-turn, so
the extra work is fine):

- **Witness-gate the early return** (`registeredNames.every(n =>
  current.has(n))`, `index.ts:652-654` today; `registeredNames` there is
  already the per-toolset slice, `[...spec.names].filter(n =>
  registered.has(n))`). A no-op requires the on state
  to be fully *witnessed* — every member registered **and** every member
  active: `registeredNames.length === spec.names.size &&
  registeredNames.every(n => current.has(n))`. The `appendEntry`/emit pair
  after the gate stays: `_applyEnable` is the only place the *enabled*
  direction is persisted (the disable direction writes at `_applyDisable`
  `:673`; the full `appendEntry` call-site list is `_applyEnable` `:658`,
  `_applyDisable` `:673`, `setDefaultResolutionMode` `:934`,
  `clearToolsetEntry` `:1023` — the restore path and `applyToolsetEnabled`
  deliberately never write; see the inert-toolset note below). The added
  length test is the point: `[].every(...)` on an empty `registeredNames` is
  vacuously true, so a gate tested only over the registered set (or over the
  actuatable set, which has the same hole) early-returns on a toolset whose
  server has not connected yet and deletes the sole intent write — the
  explicit `enabled: true` is never recorded, so the toolset resolves through
  the remaining tiers to `defaultEnabled ?? true`, coinciding with the default
  for default-on toolsets (no emit either way, so a consumer UI never learns
  the toggle happened) and force-removing every turn for a
  `defaultEnabled: false` toolset once its members become actuatable again
  (`reassertDisabled`, `index.ts:513-560`). With the length test, a
  partially-registered toolset is never witnessed on, and the write happens.
- **Filter the union**:
  `const toAdd = registeredNames.filter(n => actuatable.has(n) && !current.has(n));`
  `if (toAdd.length > 0) pi.setActiveTools([...new Set([...current, ...toAdd])]);`
  A toolset whose members are all non-actuatable computes an empty `toAdd`,
  issues no loadout write, and still persists intent and emits.

**`isEnabled` is deliberately NOT rerouted.** It reads the active set and
checks membership in `spec.names`; pi guarantees every stored active name is
registered and non-hidden (`agent-session.ts:1501-1505` — the active set has a
single writer at `:1543`, and every write funnels through `_applyToolLoadout`,
which drops both), so `spec.names ∩ active ≡ actuatableNames ∩ active` and the
filter would be a provable no-op. It would only add a fresh `getAllTools()`
scan per call (`agent-session.ts:1452-1462` builds a new array), and tbox
calls `isEnabled` inside list loops. An all-hidden toolset reporting off is
the intended contract, not a defect: it cannot actuate, so it has no "on"
witness. If a future pi ever lets hidden names linger in the active set (i.e.
relaxes `_applyToolLoadout`'s filter), add the filter then — one line.

`_applyDisable` (`index.ts:666-678`) gets the mirror-image witness gate. Its
early return (`filtered.length === current.length`, `index.ts:670`) is a
purely observational test — no active tool belongs to the toolset — and is
vacuously satisfied by any inert toolset, so today `disable()` on an
all-hidden or not-yet-connected toolset writes no entry, emits nothing, and
leaves the persisted intent ON. The gate becomes: no-op only when the off
state is fully *witnessed* — every member registered and actuatable, and none
of them active:

```ts
// per-toolset slice, mirroring _applyEnable's registeredNames —
// getActuatableNames returns the global set, never compare its size
const actuatableNames = [...spec.names].filter((n) => actuatable.has(n));
const witnessedOff =
    actuatableNames.length === spec.names.size && // all registered ∧ actuatable
    filtered.length === current.length;           // and none active
if (witnessedOff) return;
if (filtered.length !== current.length) pi.setActiveTools(filtered);
pi.appendEntry(spec.persistKey, { enabled: false });
_emitToolsetEvents(spec, pi, TOOLSET_EVENTS.changed, false);
```

The removal filter itself is unchanged, and **that asymmetry is the rule, not
an oversight: actuation filters through `getActuatableNames`; removal filters
by raw `spec.names`.** A hidden member must not be handed to `setActiveTools`,
so the "adding" direction needs the filter. Removal is the opposite: a
stale-but-active member must be removed even if it is no longer registered
(or is hidden — it can never be active, so including it is a no-op), which is
exactly why `_applyRestoreToolset`'s disable branch deliberately uses
`spec.names.has(n)` (`index.ts:695-702`, see its existing comment). Do not
"fix" the removal paths.

The gate costs one extra `getAllTools()` pass per explicit disable (to resolve
`actuatableNames`) — the same class of cost `_applyEnable` already accepts.
For a toolset whose members are all registered and actuatable, `witnessedOff`
collapses to today's `filtered.length === current.length`, so fully-registered
toolsets are bit-identical; only inert and partially-registered toolsets
change behaviour. The empty-`names` no-ops pinned by `__tests__/core.test.ts`
("Toolset with empty names") still hold without a special case on both paths:
a vacuous witness (`0 === 0`, `[].every(...) === true`) early-returns before
any write. That makes a zero-member toolset the one state where intent
cannot be recorded — a documented wart, not an oversight: while empty,
neither toggle writes an entry, so a *new* "off" cannot be pinned (§1.5
states the consumer-side workaround), and a toolset never toggled before
emptying resolves `defaultEnabled ?? true` ("on") with no way to pin it off
until members return. A prior branch entry survives emptying (resolution
reads `spec.id`, not members), and repopulating revives actuation from
whatever intent is persisted — emptiness is temporary, not terminal.

**Inert toolsets — `enabled` means intent, not observation.** The fix splits a
flag that used to coincide. Branch entries record *intent* ("this toolset
should be on/off"); `isEnabled()` reports *observation* ("tools from this
toolset are in the active set right now"). For a non-empty toolset with zero
actuatable members — members still `hidden`, or its MCP server not yet
connected (the empty-`names` case is different, see the note above) — the
two diverge in BOTH directions, and neither state is witnessed: a hidden
member can never be active, so the toolset can never prove itself on, and
absence of activity proves nothing when nothing can be active. The contract is
therefore symmetric: an explicit `enable()` persists the branch entry and
emits `changed {enabled: true}` while issuing no `setActiveTools` call (empty
`toAdd`), and an explicit `disable()` persists the off entry and emits
`changed {enabled: false}` the same way; `isEnabled()` stays false until
actuatable members exist either way. This is the blessed contract, not an
oversight: under runtime membership inertness is normally temporary, and the
persisted entry is exactly what makes the toolset spring to life — or stay
suppressed — at the next restore event once members become actuatable.
Without the disable half, `disable()` on an intent-on inert toolset is
silently dropped: the user's "off" is neither applied nor persisted, and the
toolset resolves back on when the server connects.

Two persistence facts the implementation must respect: the restore path and
`applyToolsetEnabled` do **not** write branch entries (`applyToolsetEnabled`'s
JSDoc says so at `index.ts:1041-1046`, and neither path calls `appendEntry`)
— persistence comes solely from explicit `enable()`/`disable()` calls and
their cascades — and the early-return gates must be witness gates, not
observation gates (see the `_applyEnable` and `_applyDisable` treatments
above): a gate reading only the active set is vacuously satisfied by an inert
toolset and deletes the sole intent write. Gating the write instead on
`effectiveEnabled`'s resolved intent was considered and rejected:
`ExtensionAPI` exposes `appendEntry` but not `sessionManager` (documented on
`clearToolsetEntry`'s JSDoc), and `_applyEnable`/`_applyDisable` are reached
from the `Toolset` handle methods and the cascade with only `pi` in hand, so
the intent tiers cannot be resolved there — the witness design derives the
same persistence guarantee from the active set alone. Suppressing the emit
would leave consumers with no signal at all — a toolset silently absent from
the event stream that later exists without anyone being told — so the emit
paths are NOT rerouted; the `applyToolsetEnabled` and restore-path JSDoc state
the rule: an inert toolset announces `enabled: true`/`enabled: false` while
declaring nothing, and `isEnabled()` is false until actuatable members exist.

**The consumer rule is per use site, not blanket.** An earlier draft of this
plan told consumers to "render on/off state from `isEnabled()`, not by
replaying the event stream" — which is exactly backwards for the inert case
this contract blesses: `isEnabled()` is observation, so an intent-on inert
toolset renders "off", and a consumer that gates its toggle on the same
observation refuses "off" on a toolset whose persisted intent is on (tbox's
guard at `pi-tbox/src/groups.ts:307` does precisely this; `_applyDisable`'s
old early return had the same shape, which is why this section replaces it
with a witness gate). A `changed` event can also announce `enabled: true`
for a toolset that declares nothing, so neither signal is right everywhere.
The rule the README states is:

- **Display and toggle-gating read intent** — `effectiveEnabled`
  (`index.ts:222-245`; internal today, exported by this release — step 2),
  called as
  `effectiveEnabled(spec, branch, readMergedToolsetDefaults())`
  (the `mode` parameter is removed in this release, §3)
  with `branch` from `ctx.sessionManager.getBranch()` inside a handler — so
  an inert toolset shows its persisted state and an "off" toggle is honored
  rather than refused. The resolver is **allowlist-aware**: under focus
  (allowlist) mode it answers `allow.includes(spec.id)` — the set-level
  override is authoritative there (per-toolset branch entries and settings
  pins are bypassed, the same rule as the restore short-circuit
(`index.ts:371-377`) and the `reassertDisabled` early return
(`index.ts:515`)) — so a suppressed toolset resolves `false` instead of
  falling through the tier chain to `defaultEnabled ?? true` and rendering
  ON while the mask is suppressing it. (`lastCustomEntry(branch,
  spec.persistKey)` alone is NOT sufficient: it reads only the chat-branch
  tier and skips the settings tier — and the allowlist
  override — that `effectiveEnabled` resolves.) The return keeps its
  internal `{ enabled, persistedEntry }` shape, unchanged by this release
  apart from dropping the `mode` parameter (§3) and gaining the allowlist
  branch — display and toggle-gating read only `.enabled`. No provenance
  field ships: no consumer needs one today, and adding one later
  (e.g. `source: "branch" | "allowlist" | "settings" | "default"`) is
  non-breaking under structural typing — the one direction that is NOT
  free later is collapsing the return to a bare boolean, which would break
  consumers' type checks and truthiness reads. The object shape is the
  contract.
- **"Is anything actually declared right now?" reads observation** —
  `isEnabled()`. The char count and any context-sensitive surface care about
  the active set, not the user's wish.
- **Persisted defaults capture intent, never a mid-session observation
  snapshot.** Capturing `isEnabled()` while a toolset is inert would pin a
  temporary divergence as a permanent misconfiguration (tbox's `defaults
  capture` reads observation at `pi-tbox/src/defaults.ts:127` and must
  switch).

Full tbox audit (six observation reads of the toolset-state class; all
verified in current source — the display/gating five switch to intent, the
capture switches to intent, and the per-tool surfaces stay observational):
`groups.ts:301` and `:307` (the "already enabled/disabled" toggle guards —
`:307` is the motivating case named above), `groups.ts:266` (`toggleAll`'s
`wasEnabled` gate — `/tbox all off` on an intent-on inert toolset currently
drops the off entirely and under-counts the summary; reading intent also lets
`/tbox all on` skip an already-intent-on inert toolset instead of re-appending
a duplicate entry), `groups.ts:239` (`describeToolset`'s state line),
`list.ts:538` (the toolset glyph in `/tbox list`), and
`defaults.ts:127` (defaults capture). The per-tool glyph (`list.ts:405`), the
char count (step 6 of the tbox plan), and the status-bar slot
(`status-slot.ts` — `computeSlotState` reads `extensionToolCounts`, i.e. the
active set directly, and "n masked" is `total − active`) stay observational —
they are declaration-sensitive surfaces, not toolset state; flipping them
would violate this rule in the other direction. Two observation-produced
edges in the slot are cosmetic and self-correcting: an intent-on inert
toolset inflates `● tbox n masked` (the tools are undeclared, so "masked" is
observationally true though the user enabled them and no mask is
suppressing them), and a non-empty but inert allowlist renders `focus:∅`
because `active === 0` though the allowlist itself is not empty — both
resolve when members become actuatable, and switching the counts to intent
would make the slot lie in the other direction (active counts must describe
the declared set). Scheduling these is part of the
tbox release (step 5 of `pi-tbox/IMPLEMENTATION_PLAN.md`).

Tests: inert (all-hidden) toolset — explicit `enable()` persists the branch
entry and emits `changed {enabled: true}` while issuing zero `setActiveTools`
calls, and `isEnabled()` stays false; explicit `disable()` on the same inert
toolset persists the off entry and emits `changed {enabled: false}`, also with
zero `setActiveTools` calls; a partially-connected toolset (some members
unregistered) persists intent on both toggles; after members become
actuatable, the next restore actuates (or suppresses) from the persisted
entry; `applyToolsetEnabled` emits but writes no entry (unchanged contract —
it routes through `_applyRestoreToolset`); the empty-`names` no-ops pinned by
`__tests__/core.test.ts` ("Toolset with empty names") still hold (a vacuous
witness early-returns before any write on both paths); in allowlist (focus)
mode `effectiveEnabled` resolves a suppressed toolset
`{ enabled: false }` and an allowlisted one `{ enabled: true }`, and the
tier chain resolves a chat-branch entry, a
settings pin, and the packaged fallback to the same values masking's own
restore and re-assert paths actuate on — the exported resolver
implements every mode, not just the tier chain.

Behaviour notes that fall out for free: the suppress side of the mask is
unaffected (a hidden member of a *non*-allowlisted toolset sits in `suppress`
but never in the active set, so it removes nothing and is not drift); if a
hidden member's exposure later flips back to `direct` (e.g. an MCP config
change), it re-enters `next`, the delta gate fires once, and the single write
plus single `changed` is a correct model-visible change; on pi < 0.99 the
actuatable set is identical to the registered set, so the exposure rewrite is
a no-op there — the witness gates still apply, but they only change toggles on
inert or partially-registered toolsets (fully-registered ones keep today's
no-op behaviour bit-for-bit).

**Mock prerequisite.** `__tests__/mock-pi.ts` cannot represent any of this
today, and without it none of the tests below are writable and the per-turn
mask regression is undetectable. Four changes:

1. **`registerTool` replaces by name.** Real pi rebuilds a name→definition
   map on refresh (`agent-session.ts:3442-3447`), so re-registering a name
   *replaces* it; the mock pushes onto an array (`mock-pi.ts:35-53`), so the
   motivating flow — an MCP server re-registering a dropped tool as `hidden`
   (`extensions/mcp/index.ts:272-277`) — would yield duplicate `getAllTools()`
   entries with conflicting exposures. Replace any existing same-name entry.
2. **`exposure` accepted *and* propagated, with no default.** `registerTool`
   gains an optional `exposure`, stored on the `ToolInfo` only when provided
   (`...(info.exposure ? { exposure: info.exposure } : {})`). Do NOT default
   it to `"direct"`: with a default the field is never absent and the
   "missing `exposure` reproduces current behaviour" test becomes
   tautological. The library reads exposure off `getAllTools()` results, so a
   mock that accepts the field but drops it during construction makes every
   hidden-member test fail as "treated as actuatable". Upstream
   `ToolInfo.exposure` is required (`core/extensions/types.ts:2062-2067`); with the
   devDependency at `^0.99.1` (step 5) the field is mandatory on `ToolInfo`,
   so the mock builds exposure-less fixtures through a widened local type
   (`Omit<ToolInfo, "exposure"> & { exposure?: string }`) rather than a bare
   omission, while `registerTool` keeps its parameter optional so the "missing
   `exposure` reproduces current behaviour" test stays non-tautological.
3. **`setActiveTools` drops `hidden` names** (`mock-pi.ts:58-60` currently
   stores them verbatim), mirroring pi's filter (`agent-session.ts:1504`).
4. **A `setActiveTools` call log.** The mock overwrites `_activeTools` in
   place, so the redundant-write symptom — a write of an *identical* list every
   turn — is invisible in `getActiveTools()` state. The per-turn tests assert
   over the full history (call count, identical-list detection, and "no call
   containing a hidden name anywhere" spans restore + several turns), so
   record **all** invocations (an array of argument lists — cheap, and a
   counter plus last-args is insufficient for the union assertions).

Tools registered without `exposure` produce a `ToolInfo` without the field,
which reads as actuatable — existing tests are untouched.

Tests: mixed toolset (one hidden + one visible) enables/disables/reports
correctly; all-hidden toolset — `enable()` and `disable()` each persist a
branch entry and emit `changed` but issue no `setActiveTools` call, `isEnabled`
stays false (asserting the unchanged contract); missing `exposure` on every
tool reproduces current behaviour; allowlist mode with a hidden member — zero
extra `setActiveTools` calls and zero `changed` emits across consecutive turn
boundaries, and no `setActiveTools` containing a hidden name anywhere.

### 3. Removal of the `inclusion` resolution mode (breaking — why this is 2.0.0)

The deprecation window closes; `inclusion` is deleted, not warned about
further.

- `DefaultResolutionMode` becomes `"exclusion" | "allowlist"`
  (`index.ts:59`). TS consumers passing `"inclusion"` now fail at compile
  time — the loud, build-time break is the migration path for source
  consumers. The `@deprecated` JSDoc on the type (`index.ts:52-57`) and on
  `setDefaultResolutionMode` (`index.ts:891-897`) is replaced by the
  narrowed type.
- `setDefaultResolutionMode` (`index.ts:898-938`) accepts only the two
  surviving modes: the `warnInclusionDeprecation()` call at the top and the
  `"inclusion"` arm of the validation union and its error message are
  deleted. There is no runtime acceptance path left at write time.
- **Legacy persisted state is ignored, never throws.** A chat branch can
  still carry a `{ mode: "inclusion" }` entry from a pre-2.0.0 session.
  Restore's mode read (`index.ts:348-357`) collapses to a single test —
  `branchMode === "allowlist" ? "allowlist" : "exclusion"` — so a legacy
  `"inclusion"` entry is simply an unrecognized value, resolved by the same
  silent fall-through the read already applies to any corrupt value (the
  allowlist read's `Array.isArray` fallback recovers silently the same
  way). No clamping branch and no warning: `warnInclusionDeprecation`,
  `DEPRECATION_WARNED_KEY`, and the message const are deleted outright —
  both callers go with the mode (the setter's write-time call and the
  restore read's call, Gap 3). The migration story is one
  sentence in the CHANGELOG instead of runtime machinery: a legacy
  `inclusion` session restores under the default `exclusion` floor, so
  previously-suppressed unpinned toolsets come back ON — the same default
  every fresh session starts from. That direction is stated, not hidden:
  the clamp framing ("safe recovery") was wrong — recovering to
  `"exclusion"` fails OPEN, which is exactly why the allowlist read
  (`index.ts:331-346`) refuses it for `"allowlist"` entries; the difference
  here is that no `"inclusion"` consumer exists to suppress anything
  (verified: tbox, lean-host, lean-portal, lean-search), so the floor is
  unreachable in practice.
- `effectiveEnabled` (`index.ts:222-245`) loses its `mode` parameter
  outright — the inclusion floor was its only use. The tier chain collapses
  to chat-branch entry → settings pin → `defaultEnabled ?? true`; the
  allowlist-aware early return (step 2) survives — now reading the mode
  from the passed `branch` via the shared helper instead of module state —
  and becomes the only mode-sensitive behaviour in the resolver; the
  return keeps its `{ enabled, persistedEntry }` shape (step 2 — no
  provenance field ships until a consumer needs one).
- `getDefaultResolutionMode()` keeps its name and shape; its return type
  narrows with the union. It carries no JSDoc of its own (`index.ts:940`) —
  the `"inclusion"` bullets to delete are in `setDefaultResolutionMode`'s
  JSDoc (`index.ts:885-891`), removed with its `@deprecated` tag (`:891-897`).

Tests: a persisted `{ mode: "inclusion" }` branch entry restores as
`"exclusion"` with no error across repeated restore events (the entry is
ignored, not migrated); `setDefaultResolutionMode(pi, "inclusion")` throws (the invalid-mode error
now lists only the two valid modes); `effectiveEnabled` resolves an
unpinned, unpersisted toolset to `defaultEnabled ?? true` with no mode
argument; the ~39 inclusion references in `__tests__/core.test.ts` are
deleted with their scenarios.

## Scope

In: the two fixes above, the `inclusion` removal (§3), their tests, docs,
and a major release.

Out:

- No exposure-aware filtering of members (the library stays exposure-agnostic;
  the only exposure read is the `hidden` check in `getActuatableNames`).
  Consequence to document, not fix, in **both directions**. Forward: with
  the toolset on, `codemode` and `deferred` members pass the filter (pi's
  `_applyToolLoadout` drops only `hidden`, `agent-session.ts:1501-1505`), so
  masking's `setActiveTools` declares them to the model, defeating that
  exposure's lazy-loading purpose. Reverse: with the toolset *off*,
  `tool_search` still lists deferred/codemode members in its catalog and
  loads them mid-turn via `setActiveTools` (`extensions/tool-search/tool.ts:208`);
  the next `before_agent_start` removes the name again
  (`reassertDisabled`/`reassertAllowlist`), and since `searchAndLoad`'s
  candidate filter is `!active.includes(name)` (`tool.ts:205`) the tool
  re-enters the searchable set — a model that keeps searching produces a
  bounded one-write-per-turn oscillation of the same shape as the pi-core
  force-add residual below. Masking's removal is correct in that case (an
  off toolset is user intent; the load circumvents it), so no re-assert
  exemption is planned — and none is currently implementable: the
  declaration-time check is impossible (MCP exposure lives in the user's
  `mcp.json`, is unknowable before registration, and can change mid-session
  when pi re-registers dropped tools as `hidden`), and a restore-time throw
  would brick `/resume`. That story covers `deferred` (the `tool_search`
  path); `codemode` is harder — `_getCallableTools`
  (`agent-session.ts:1488-1492`) returns every `codemode`/`deferred` tool
  regardless of the active set, so a `codemode` member of an off toolset
  stays script-callable via `ctx.executeTool` with no load event for the
  re-assert to undo — masking cannot suppress it. Masking is context
  hygiene, not a reachability boundary; the README caveat states both
  halves so its wording matches `pi-tbox/IMPLEMENTATION_PLAN.md`. Consumers
  keep member sets to `direct`/`model-only` exposure (tbox does); the README
  says so and adds the caveat: a deferred/codemode tool inside a
  toggled-off toolset loads only transiently via `tool_search`
  (`searchAndLoad` activates it mid-turn; the re-assert removes it at the
  next turn boundary), and a `codemode` member stays script-callable while
  off — toggle the toolset on instead of relying on either edge.
- No `preserve`/"no opinion" default. Masking's `defaultEnabled` remains an
  instruction to actuate; consumers that need pi's own activation to stand use
  homogeneous member sets.
- No `prepareLoadout`/`hiddenDeclarations` use — the reason is semantic, not
  ownership (a library *could* register a hook-carrying tool):
  `hiddenDeclarations` only filters the *declarations* of already-active
  tools out of request payloads (`_installHiddenDeclarationsProjection`,
  `agent-session.ts:1688-1707`; hook contract `types.ts:546-554`); the tools
  stay in `agent.state.tools`, active and callable — the opposite of
  masking's remove-from-active-set contract. The one shipped user is
  codemode's `mode: "only"`, an all-or-nothing declaration hide scoped to
  the hook owner, not a per-toolset toggle.
- No membership event of any kind. Runtime membership mutation is
  caller-initiated (§1), the `changed` payload has no membership slot, and a
  new event type would expand the event contract in this release.
  Second-order consumers re-read `spec.names` via `getRegisteredToolsets()`;
  the README says so.
- No replacement or migration mode for `inclusion` beyond ignoring the
  persisted entry (§3) — `"allowlist"` is the documented substitute for focus-style
  suppression, and no `1.x` compatibility shim is added for a mode nothing
  sets.
- No change to the mask definition, cascade, settings tier, or child-defer
  semantics. The focus/allowlist and restore paths change only their name
  source (registered → actuatable); what they compute and enforce is identical.
  Hidden members have three live sources (a `hidden` `mcp.json` exposure,
  `/mcp` disable/remove re-hiding a server's tools, and re-registration of
  dropped tools — see the header), but no known consumer scopes toolsets to
  whole servers, so no toolset member reaches any of them today — latent,
  not live.
- No handling of pi-core's own mid-session force-add. With
  `--tools`/`allowedToolNames` configured, pi re-adds every listed declarable
  name to the active set on every tool-registry refresh
  (`agent-session.ts:3488-3494`; `_allowedToolNames` from
  `config.allowedToolNames` at `:465`), and since 0.99 a refresh runs on
  every `registerTool` (`core/extensions/loader.ts:299`) — every MCP
  connect, `tools/list_changed`, and extension registration. The flag also
  *filters the registry*: `_refreshToolRegistry` drops any name not on the
  list from `_toolDefinitions`/`_toolRegistry` (`agent-session.ts:3420-3435`,
  via `isAllowedTool`), so a non-listed tool is unregistered to every
  consumer including `getAllTools()` — for masking that is just the
  partial-registration case the witness path already handles. That is a
  second force-add actor of the same class the re-assert's residual
  attributes to later-loading extensions, except it lives inside pi where no
  extension hook exists. The turn-boundary re-assert still absorbs it: a
  forced name that is also a member of an effectively-off toolset is removed
  at the next `before_agent_start` (`reassertDisabled`/`reassertAllowlist`),
  so the worst case is a bounded one-write-per-turn oscillation between pi's
  refresh and masking's next pass, and forced names belonging to no toolset
  are correctly left alone. Nothing in this release changes that — the
  forced names are declarable by construction (pi checks `_isDeclarable`
  inside the force-add loop), so the exposure fix is irrelevant here — and
  no extension-side fix exists; it needs the same pi-core masking primitive
  at the `setActiveTools` boundary the re-assert's residual already names
  (`AGENTS.md`, Residual). Recorded here so a future audit enumerates all
  force-add actors, not just extensions.

## Steps

1. Gap-1 docs: correct the `getRegisteredToolsets` JSDoc (`index.ts:978-984`)
   and the README's "read-only snapshot" line (step 4) — the returned array is
   a copy but its entries are live; state the raw-mutation contract (§1),
   including its no-overlap-guard caveat. Add one regression test pinning that
   registry entries are live.
2. Rewrite `getRegisteredNames` in place as `getActuatableNames` (registered
   ∧ non-hidden, one `getAllTools()` pass) — the restore-allowlist,
   `reassertAllowlist`, `_emitToolsetEvents`, and restore-enable call sites
   switch by the rewrite; `_applyEnable` gets the dual-set treatment with the
   witness-gated early return (`appendEntry` and emit untouched; the
   `setActiveTools` union filtered through the actuatable set), and
   `_applyDisable` gets the mirror witness gate (removal filter unchanged);
   note the inert-toolset rule (announce `enabled: true`/`enabled: false`
   while declaring nothing; persistence comes only from explicit
   `enable()`/`disable()`) in the `applyToolsetEnabled` and restore-path
   JSDoc. Make `effectiveEnabled` (`index.ts:222`) allowlist-aware before
   exporting it, and keep its return exactly `{ enabled, persistedEntry }`
   — no rename, no new field. `persistedEntry` ships as a fact about the
   branch ("a chat-branch entry exists for this toolset"), not a claim
   about which tier decided; under allowlist mode the allowlist decides
   while `persistedEntry` still reports branch-entry existence, and only
   external callers can observe that combination. No provenance field
   ships: no consumer reads one today, and adding
   `source: "branch" | "allowlist" | "settings" | "default"` later is
   non-breaking (object → more fields survives structural typing and
   destructuring); the one permanently-closed direction is collapsing the
   return to a bare boolean, which would break consumers' type checks and
   truthiness reads — so the object shape is the contract. Detection
   reads the mode from the passed `branch`, not module state: extract the
   mode-entry read + normalization out of `doRestore` (`index.ts:321-357` —
   the `lastCustomEntry(branch, MODE_PERSIST_KEY)` read, the mode
   normalization (collapsed to §3's single ternary), and the fail-closed
   `[]` allowlist recovery) into one helper used by
   BOTH `doRestore` and the resolver, so restore and the exported resolver
   cannot drift on what the persisted mode is, and the resolver becomes a
   pure function of its declared inputs. `getActiveAllowlist()` (module
   state) was rejected: it is a mirror populated only by masking's own
   restore, so a consumer whose handler runs before masking's in a fresh
   process would see `undefined` and fall through to the tier chain —
   reporting a suppressed toolset ON, the exact failure this export exists
   to prevent — and it only ever reflects the current branch, not the
   `branch` argument. The allowlist branch returns
   `{ enabled: allow.includes(spec.id) }`, so the
   exported resolver implements ALL modes, not just the tier chain: without
   it, a consumer calling the exported resolver under focus mode gets the
   tier-chain fallthrough (`defaultEnabled ?? true` = on) for a toolset the
   mask is suppressing. Bit-identical for existing behaviour: both internal
   callers (`doRestore`'s per-toolset loop and `reassertDisabled`)
   short-circuit before reaching it in allowlist mode, so only the newly
   exported consumer path gains correctness. The one internal reader of the
   old boolean — `doRestore`'s per-toolset loop (`index.ts:442-448`) —
   keeps passing `persistedEntry` to `_applyRestoreToolset`, semantics
   unchanged (`restored` vs `changed`); that loop is never reached in
   allowlist mode (the short-circuit emits `restored` unconditionally), so
   the allowlist-plus-entry combination is observable to external callers
   only.
   One caller's input source changes with it — the one way this is not
   purely bit-identical: `reassertDisabled`
   (`index.ts:513-560`) reads the mode from the module-state mirror today
   (`ms.defaultResolutionMode`, `:522`); after this edit its mode comes from
   the branch via the resolver. The two can disagree only if a
   `before_agent_start` fires while the branch's last mode entry says
   `"allowlist"` but no restore has populated the mirror yet (or a foreign
   writer appended a mode entry) — in that window the branch-derived value
   suppresses every toolset, which is the safe direction: branch
   overrides mirror fails closed, the same asymmetry the restore-time
   allowlist recovery comment already establishes
   (`index.ts:331-346`). Practically unreachable — `session_start` /
   `session_tree` precede any turn, and deferring children return earlier
   in the dispatcher — but stated so the "bit-identical" claim is not read
   as covering `reassertDisabled`'s input provenance.
   Export it so the consumer rule below is implementable without
   re-deriving intent resolution — its other input
   (`readMergedToolsetDefaults`) is already exported. Drop its `mode`
   parameter in the same edit: §3 removes the inclusion floor, the
   parameter's only reader.
3. `MockPI`: `registerTool` replaces same-name entries and accepts/propagates
   `exposure` (no default); `setActiveTools` drops `hidden` names and records
   a call log. Then tests in `__tests__/core.test.ts`, including the
   per-turn allowlist-mask case and the §3 removal tests (a legacy
   `{ mode: "inclusion" }` branch entry restores as `"exclusion"`,
   invalid-mode throw, mode-less `effectiveEnabled`).
4. README: document runtime membership mutation (the raw pattern from §1,
   including the not-activated-on-registration and member-removal edges from
   the contract caveat, the no-overlap-guard caveat, the dead-toggle edge of
   an emptied toolset (§1.5), and that it emits no event — second-order
   consumers re-read membership via `getRegisteredToolsets()` rather than
   caching it), the `hidden`-exposure
   behaviour, the inert-toolset `enabled` semantics (intent vs observation,
   with the per-use-site guidance: intent for display/toggle-gating/defaults,
   observation for declaration-sensitive surfaces), and the
   `direct`/`model-only`-only member expectation (§Scope), and the
   `tool_search` caveat for off toolsets with deferred/codemode members
   (§Scope — toggle the toolset on instead of relying on either edge:
   transient `tool_search` loads, or script-callable `codemode` members).
   Correct the
   `getRegisteredToolsets()` section's "read-only snapshot" line the same way
   as the JSDoc in step 1 — the array is a copy, its entries are live.
   Document the mode removal: `inclusion` is gone, the union is
   `"exclusion" | "allowlist"`, and pre-2.0.0 branches carrying
   `{ mode: "inclusion" }` restore as `"exclusion"` — the entry is ignored,
   not migrated, so unpinned toolsets come back at the default-on floor.
   Also correct surfaces this contract newly contradicts (refs verified in
   the current README): `README.md:376` ("a live toggle emits only when
   state actually changes (no-op toggles are suppressed)" — the witness
   gates deliberately emit for inert and partially-registered toolsets),
   `README.md:373` (the `Default resolution` mode list), `README.md:301-302`
   (the inclusion-mode focus comment), `README.md:129` (the
   `DefaultResolutionMode` union row), and `README.md:99` (the
   `"inclusion"` mode row). Give the new `effectiveEnabled` export a README
   API subsection and a row in `AGENTS.md`'s public-API table.
   Update this repo's `AGENTS.md` in the same pass: the
   `setDefaultResolutionMode` row in its public-API table (line 77) still
   lists `"inclusion"` (deprecated since 1.2.0) — drop that bullet so the
   agent-facing contract matches the narrowed union.
5. Bump `devDependencies["@earendil-works/pi-coding-agent"]` from `^0.84.4` to
   `^0.99.1` and fix the type fallout — 0.99 `ToolInfo`/`ToolDefinition` may
   add required fields the mock must fill, and the exposure *read* keeps its
   defensive cast (it must still compile against consumers' older types; see
   §2 capability detection). One fallout to expect: under 0.99 types the
   mock's `getAllTools(): ToolInfo[]` return cannot carry §2's widened
   `exposure?: string` fixtures (the field is required there), so the
   return needs a cast or a narrowed stored-exposure type on top of the
   widened fixture type. Then `npm test` and `npx tsc --noEmit` (no
   `typecheck` npm script exists; CI runs exactly this pair).
6. CHANGELOG `[Unreleased]` → `2.0.0`: a `Removed` section for the
   `inclusion` mode (the type member, its `setDefaultResolutionMode`
   acceptance, and the resolver mode floor — persisted `{ mode: "inclusion" }` entries
   are ignored and resolve to `"exclusion"`, so unpinned toolsets restore
   at the default-on floor), plus the note that toggles on
   partially-registered toolsets now persist intent and emit (the witness
   gates, §2); `npm run release:major`.

## Validation

`__tests__` only — no external services, matching the existing suite. All
three changes are pure library logic with no pi-version dependency beyond
the capability check; the inclusion removal's only external surface is
persisted branch entries, covered by the legacy-entry test in §3.

## Compatibility

- Breaking, and why this is `2.0.0`: the `inclusion` mode is removed (§3) —
  the `DefaultResolutionMode` union member, its `setDefaultResolutionMode`
  acceptance, and the resolver mode floor. Otherwise `Toolset` keeps its
  shape and no other signature changes; the only addition is the
  `effectiveEnabled` export (step 2 — without a `mode` parameter, it never
  shipped with one, and it returns its existing internal shape
  `{ enabled, persistedEntry }`; a provenance field can be added later
  non-breakingly if a consumer ever needs one). The break is silent at runtime: a `{ mode: "inclusion" }`
  branch entry is ignored and resolves to `"exclusion"`, so old sessions
  degrade to the default-on floor rather than erroring —
  previously-suppressed unpinned toolsets come back ON. The one behavioural change for existing
  consumers is the
  witness gates: toggles on *partially-registered* toolsets now persist intent
  and emit instead of silently no-oping (the intended fix; fully-registered
  toolsets are bit-identical) — branch entries accumulate per explicit toggle
  on such toolsets, and `changed` events fire where none did. The CHANGELOG
  calls this out (step 6).
- The devDependency bump to `^0.99.1` (step 5) is types-only for this repo:
  no runtime pi version is required (the capability check keeps older pi
  working), and node `engines` are identical (`>=22.19.0` in both 0.84.4 and
  0.99.1). It closes a fidelity gap — at `^0.84.4` the real 0.99 `ToolInfo`
  shape was never typechecked here, and the `exposure` path was exercised
  only through the mock's cast. It does **not** change what consumers need:
  the library's shipped source keeps compiling against pre-0.99 types (the
  defensive reads in §2), so consumers on `^0.84.4` types are unaffected —
  they upgrade their own pi devDependency on their own schedule.
- `pi-lean-dimension` pins `^1.3.0`, which `2.0.0` does not satisfy — it
  stays on the 1.x line until it opts in, and needs nothing from this
  release: it registers fixed, non-hidden member sets and never sets
  `inclusion` (its only mode references are comments explaining it avoids
  the deprecated API). If it later widens its range it also gains the
  witness-gate fix, but that is its range choice, not a forcing function.
- No `peerDependencies` change. The library declares none today; keep it that way.
- The `hidden` fix requires `exposure` to be useful; without the field (older pi)
  behaviour is unchanged, so no minimum pi version is introduced.

## Consumer note

`pi-tbox` changes toolset membership at runtime for MCP servers whose tools
change mid-session; it does so by assigning `entry.spec.names` directly on the
live registry entry (§1 — no library API needed). It depends on `^2.0.0` for
the allowlist-aware `effectiveEnabled` export, and inherits the `inclusion`
removal as a no-op (tbox source and tests only ever set
`"exclusion"`/`"allowlist"`, and no consumer-side edit exists to make —
see Gap 3);
until this release is
published, tbox's CI cannot resolve it, so this ships first. Per the per-use-site rule in §2, tbox reads intent vs
observation per use site: display and toggle-gating from the persisted intent
(`effectiveEnabled`, exported by this release), declaration-sensitive surfaces (the char count) from
`isEnabled()`, and persisted defaults from intent — never from a mid-session
`isEnabled()` snapshot. The `changed`-event caution still holds: an event can
announce `enabled: true` for a toolset that declares nothing. tbox has six
observation reads of the toolset-state class (`groups.ts:301`, `:307`,
`:266`, `:239`, `list.ts:538`, `defaults.ts:127` — enumerated in §2), all of
which switch to intent (the per-tool glyph, char count, and status-bar slot
stay observational — see §2); that audit is part of the tbox release — see
`pi-tbox/IMPLEMENTATION_PLAN.md`.
