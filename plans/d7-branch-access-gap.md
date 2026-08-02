# Gap: `clearToolsetEntry(pi, …)` needs branch access that `ExtensionAPI` doesn't expose

**Plan:** [`settings-tier-and-allowlist-mode.md`](./settings-tier-and-allowlist-mode.md), Step 5 (D7 tombstone helpers)
**Status:** design gap found during implementation — plan may need a revision before Step 5 lands

## The problem

D7 specifies:

```ts
export function clearToolsetEntry(pi: ExtensionAPI, persistKey: string): void;
export function clearAllToolsetEntries(pi: ExtensionAPI): void;
```

The tombstone-write convention requires **reading the branch** — append `null`
only if the key has a prior entry whose last entry isn't already cleared
(never-toggled toolsets must get no tombstone, repeated restores must not stack).

```ts
// (source branch, feat/stored-settings-state, index.ts:611)
export function clearToolsetEntry(pi: ExtensionAPI, persistKey: string): void {
 const last = [...(pi as any).sessionManager.getBranch()]
  .reverse()
  .find((b: any) => b.customType === persistKey);
 const alreadyCleared = last?.data == null || (last as any)?.data?.enabled == null;
 if (!alreadyCleared) {
  pi.appendEntry(persistKey, null);
 }
}
```

`(pi as any).sessionManager` **does not exist on real `ExtensionAPI`**. Only
`ExtensionContext` has `sessionManager` (pi-core `types.d.ts:219`). Verified in
the installed runtime (`pi 0.83.0`):

- `dist/core/extensions/loader.js:186` `createExtensionAPI()` builds the api
  object literal — no `sessionManager` property anywhere.
- `dist/core/extensions/types.d.ts:855` `interface ExtensionAPI` — only
  `appendEntry` etc.; no branch read at all.
- `ExtensionContext` (types.d.ts:210) has `sessionManager` — that's the object
  event handlers / command handlers receive, not the `pi` factory arg.

So in production this throws `TypeError: Cannot read properties of undefined
(reading 'getBranch')` the first time `/tbox defaults restore` runs.

## Why tests pass anyway

The source branch's **MockPI added a `sessionManager` getter to the `pi`
instance** (`__tests__/mock-pi.ts:105`) to make `(pi as any).sessionManager`
work in tests. That's a mock-only illusion — it doesn't exist on the real
runtime api object. The gap is invisible to the test suite.

## The plan already knew this — and contradicts itself

D5 (the `getActiveAllowlist` rationale) says:

> **Why not `pi: ExtensionAPI`:** the consumer call site receives
> `pi: ExtensionAPI`, which does not expose `sessionManager` (that property is
> on `ExtensionContext` only — verified against pi-core `types.d.ts`).

So the plan correctly identified that `pi` has no `sessionManager` — and used
it to justify a parameterless `getActiveAllowlist()`. But D7's helpers take
`pi: ExtensionAPI` **and need branch reads**. Same fact, opposite conclusion.
One of D5 or D7 is wrong.

The pi-tbox design doc (`/root/pi-tbox/docs/defaults-and-focus-unified-plan.md`)
carries the same broken pattern (`pi.sessionManager.getBranch()`), and the
current plan's "How G dissolves restore" flow calls `clearAllToolsetEntries(pi)`
from a command handler — where `ctx` (not `pi`) is the object with branch access.

## What the call site actually looks like

`/tbox defaults restore` is a command handler:

```ts
pi.registerCommand("tbox", {
 handler: async (args, ctx) => { … },  // ctx: ExtensionCommandContext
});
```

- `ctx` has `sessionManager.getBranch()` ✓ but **no `appendEntry`**.
- `pi` (the factory arg, captured in closure) has `appendEntry` ✓ but **no
  `sessionManager`** and no branch read.

Neither object alone can implement `clearToolsetEntry`'s dedup contract.

## Options

### A. Read branch from `ctx` instead of `pi` (signature change)

Pass the command context (or its `sessionManager`) to the tombstone helpers:

```ts
export function clearToolsetEntry(
 pi: ExtensionAPI,
 persistKey: string,
 ctx: ExtensionContext,          // or a narrower { sessionManager } reader
): void;
```

or invert: `clearToolsetEntry(ctx, pi, persistKey)`. `clearAllToolsetEntries`
would take both too. Call site passes the `ctx` it already has.

- Pro: works in production; dedup contract preserved exactly.
- Con: signature deviates from D7 as written; two "pi-like" args is awkward.

### B. Drop the dedup requirement — always append `null`

`clearToolsetEntry(pi, persistKey)` = `pi.appendEntry(persistKey, null)` when
the last entry isn't already null — but we can't check that without branch
access, so: just append `null` unconditionally (or on a best-effort in-memory
mirror). Simplest; no branch read needed at all.

- Pro: matches the D7 signature as written; one line.
- Con: never-toggled toolsets get a redundant tombstone; repeated restores
  stack `null`s (harmless, last-wins — the plan already accepts tombstone
  accumulation with a `ponytail:` note). Violates the plan's own "no tombstone
  for never-toggled toolset" test expectation; that test would change.

### C. Module-state mirror of branch toolset entries

The library already mirrors mode/allowlist into module state; extend the
mirror to per-toolset last-entries, updated wherever the library appends.
`clearToolsetEntry` reads the mirror instead of the branch.

- Pro: keeps `pi`-only signature.
- Con: mirror drifts for entries written by *other* consumers (companion
  mirrors, direct `appendEntry` callers — pi-tbox itself writes
  `{enabled:true}` entries in `src/focus.ts:156`); the whole point of
  re-reading the branch per toolset in `doRestore` was to see other writers'
  entries. A stale mirror reintroduces exactly the desync the plan works hard
  to avoid. Rejected on that basis.

### D. Restrict to "restore always clears everything"

Downstream `restore` could skip the helpers entirely and rely on
`clearAllToolsetEntries` semantics folded into restore: tombstone every
registered toolset unconditionally. Same as B but moves the decision
downstream.

- Pro: library API stays minimal (or the helpers are dropped).
- Con: same redundant-tombstone cost as B, plus it leaks the tombstone-write
  convention back into pi-tbox — the opposite of D7's stated goal.

## Recommendation

**A** (pass the `ctx`/branch reader alongside `pi`), or **B** (drop dedup) —
the two that work in production. A preserves the plan's dedup semantics
exactly at the cost of a signature change; B keeps the signature and shrinks
the contract, at the cost of the never-toggled dedup guarantee.

The cleanest variant of A that minimizes the D7 churn: keep
`clearToolsetEntry(pi, persistKey)` public shape but require the branch
snapshot as a third arg (the caller already has `ctx.sessionManager`):

```ts
export function clearToolsetEntry(
 pi: ExtensionAPI,
 persistKey: string,
 branch: SessionEntry[],   // from ctx.sessionManager.getBranch()
): void;
```

Call site: `clearAllToolsetEntries(pi, ctx.sessionManager.getBranch())`.

Note this also means the **pi-tbox design doc** (`defaults-and-focus-unified-plan.md`)
needs the same correction wherever it reads `pi.sessionManager` — that doc is slated for revision anyway per the plan's scope note.

## Files / tests affected if we revise

- `index.ts`: `clearToolsetEntry` / `clearAllToolsetEntries` signatures (+
  `SessionEntry` import from pi-core, if option A).
- `__tests__/mock-pi.ts`: the fake `sessionManager` getter on the pi instance
  becomes unnecessary for the real API (keep it only if some test still uses
  `pi.sessionManager` directly — none should).
- `__tests__/core.test.ts`: BT1–BT4 test call sites (`clearToolsetEntry(pi, …)`
  → add branch arg, or change assertions under option B).
- `plans/settings-tier-and-allowlist-mode.md` D7 + test-scope paragraph.
- `/root/pi-tbox/docs/defaults-and-focus-unified-plan.md` (downstream).
- `applyToolsetEnabled` (D8) is **unaffected** — it takes `pi`, but only
  touches `setActiveTools`/events, no branch read.
