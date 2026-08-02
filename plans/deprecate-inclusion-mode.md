# Plan: deprecate and remove `inclusion` resolution mode

**Status:** the deprecation half lands with `1.2.0` (in the
[`settings-tier-and-allowlist-mode.md`](./settings-tier-and-allowlist-mode.md)
PR); the removal half follows after a few minors. This doc reverses the
prior "keep `inclusion` as-is, no deprecation" decision recorded in that
plan — `allowlist` is the mode `inclusion` should have been, so `inclusion`
goes through a deprecation window and then out, rather than lingering as a
second, weaker primitive.

**Versioning caveat (deliberate):** removing a public export is a breaking
change. Strict semver would gate it behind `2.0`. This is a new library with
few downstream consumers, so we bend semver and remove in a `1.x` minor,
flagged with a prominent **Breaking** CHANGELOG entry. Revisit if the
consumer surface grows before the removal lands — once real third-party
deps exist, switch to a `2.0` bump instead. `ponytail:` this is the one
semver corner we're cutting on purpose, for an early library.

## Why

`inclusion` mode is an unbounded **floor**: toolsets with no persisted
entry default off, but the set of "on" toolsets is never recorded, so a
toolset registered *after* focus was entered leaks on. The retrospective
(`docs/settings-tier-and-allowlist-suppression-retrospective.md`) named
this as the fundamental flaw. `allowlist` is the correct implementation of
the same intent — a **finite, branch-persisted array** whose complement is
computed at restore over toolsets that may not exist yet. Keeping both
indefinitely leaves a confusingly-overlapping API surface and a footgun
the new mode exists to close. Deprecate → remove, on a normal version
curve.

## Phase 1 — deprecate (ships in `1.2.0`)

Behavior unchanged for any caller still on `"inclusion"`; the only new
runtime effect is a warning. No export removed, no type narrowed — purely
additive signaling so external consumers (if any) get a runway.

- **Type doc.** `DefaultResolutionMode` is a string union, so a single
  member can't carry `@deprecated`. Instead, the JSDoc on the type and on
  `setDefaultResolutionMode` gains a `@deprecated` note: `"inclusion"` is
  deprecated since `1.2.0`, use `"allowlist"` for focus-style suppression
  (or `"exclusion"` for the default-on floor). Scheduled for removal in a
  near-term `1.x` minor.
- **Runtime warning, emitted once per process per trigger site:**
  - `setDefaultResolutionMode(pi, "inclusion", …)` →
    `[pi-tool-masking] "inclusion" resolution mode is deprecated since 1.2.0 and will be removed in a coming 1.x minor; use "allowlist" for focus suppression.`
  - `doRestore` resolving a branch mode entry to `"inclusion"` → same
    message. (This is the path that fires on `/reload` of a session that
    last set inclusion.)
  - Guard with a module-level `Set<string>` of already-warned keys
    (`"setDefaultResolutionMode"` / `"doRestore"`) so a loop or repeated
    restore doesn't spam. Two keys, not per-call dedup — the warning is
    "you're on the deprecated path," once per process per entry point is
    enough.
- **README.** Mark the `"inclusion"` row `@deprecated since 1.2.0`; point
  to `"allowlist"`. Update the "Focus mode (inclusion resolution)"
  example to use `"allowlist"`.
- **CHANGELOG.** `[Unreleased]` → `### Deprecated` entry naming the mode,
  the replacement, and the removal major.
- **Tests.** Keep the existing `inclusion` behavioral tests (the mode still
  works through the window). Add one test asserting the warning fires once
  from `setDefaultResolutionMode` and once from `doRestore`, and is
  suppressed on repeat.

## Phase 2 — remove (after a few `1.x` minors)

Breaking, shipped in a `1.x` minor (not gated on `2.0` — see the versioning
caveat above). Lands only after `pi-tbox` has shipped its `allowlist`
adoption (downstream sprint, anchored to published `1.2.0`) and the
deprecation warning has been in at least one minor release.

- **Type.** `DefaultResolutionMode` → `"exclusion" | "allowlist"`.
- **`setDefaultResolutionMode`.** Drop `"inclusion"` from the validity
  check; the error message becomes `Must be "exclusion" or "allowlist"`.
  Drop the now-dead `allowlist`-only-vs-inclusion branch comments.
- **`doRestore`.** Remove the `mode === "inclusion"` floor (the
  `: mode === "inclusion" ? false` ternary) and the
  `branchMode === "inclusion" || branchMode === "exclusion"` acceptance.
  **Stale-entry migration:** a branch still carrying a `"inclusion"` mode
  entry (written before upgrade) is mapped to `"exclusion"` with a
  one-time `[pi-tool-masking] legacy "inclusion" mode entry mapped to
  "exclusion"; set "allowlist" to restore focus suppression.` warn, then
  the entry is superseded by normal tiering. This is the safe default
  (toolsets default on) and the least-surprising recovery for an old chat
  branch; users who actually want suppression re-enter focus, which now
  writes `"allowlist"`. No tombstone rewrite of the legacy entry — mapping
  is in-memory, the branch is append-only.
- **Tests.** Delete the `inclusion` behavioral suite; keep one migration
  test asserting a persisted `"inclusion"` entry restores under exclusion
  semantics and warns once.
- **README / CHANGELOG.** Drop the `"inclusion"` row; a **Breaking** entry
  in `### Changed` (not `### Removed`, to land the visibility where
  minor-bump readers look) naming the removed mode and the replacement.

## Not in scope

- **Accelerating removal.** No fixed date; the removal minor lands when
  pi-tbox adoption is confirmed shipped and the deprecation warning has
  been in at least one minor release. A small `1.x` minor carrying only
  this removal is fine.
- **Auto-migrating old focus state to `allowlist`.** A legacy `inclusion`
  entry cannot reconstruct the intended allowlist (the on-set was never
  recorded), so no automatic conversion is possible. Map to exclusion +
  warn; users re-enter focus. Documented above.
- **Deprecating `"exclusion"`.** Untouched — it's the default-on floor and
  the correct baseline.
- **Re-bumping to `2.0` if a real consumer appears.** If a genuine
  third-party dep on `inclusion` surfaces before the removal minor, switch
  the removal to a `2.0` major bump and extend the deprecation window
  rather than breaking their pin silently.
