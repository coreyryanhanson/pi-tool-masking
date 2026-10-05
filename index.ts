import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Public API — types
// ---------------------------------------------------------------------------

export interface ToolsetSpec {
	/** Stable id, e.g. "my-plugin.web". Used in persist keys and event payloads. */
	id: string;
	/** Human-readable name for the group. Optional — presenters fall back to id. */
	label?: string;
	/** Tool names this toolset governs. */
	names: Set<string>;
	/** Primary persistence key the toolset writes, e.g. "toolset-state:my-plugin.web". */
	persistKey: string;
	/** Fresh-session fallback when no branch entry exists. */
	defaultEnabled?: boolean;
	/** Dependency: ids of toolsets that must be enabled for this one. */
	requires?: string[];
}

/** One entry of a toggle's change report: a toolset whose user-visible
 *  state changed (intent delta or loadout write) during the call. */
export interface ToggleResult {
	/** The toolset's spec.id — the key toggles are addressed by. */
	id: string;
	/** The enabled state this call persisted and emitted — the same value
	 *  as the appended branch entry and the `changed` event payload. */
	enabled: boolean;
}

/** Anything with a synchronous getBranch(); pi's ReadonlySessionManager
 *  satisfies this. Pass the reader object itself (in practice
 *  `ctx.sessionManager`) — never a bare `getBranch` method reference, which
 *  the type makes a compile error (an unbound method would throw).
 *  There is no branchless fallback: a site without `ctx` restructures to
 *  obtain one. An empty branch means only "no intent recorded yet". */
export interface BranchReader {
	getBranch(): readonly SessionEntry[];
}

/** A toggleable toolset handle. `enable`/`disable` return a change report
 *  (`ToggleResult[]`; `[]` = silent no-op; persist + emit iff the intent
 *  changes or a loadout write occurred). Under allowlist governance every
 *  toggle throws {@link AllowlistModeError} before anything runs — catch by
 *  `err?.name`, not `instanceof`. In a deferring child
 *  ({@link isDeferredChild}) toggles are silent no-ops (`[]`); immediate
 *  actuation under focus is `forceToolsetEnabled`'s. Pass the reader object
 *  itself (see {@link BranchReader}). */
export interface Toolset {
	enable(pi: ExtensionAPI, sessionManager: BranchReader): ToggleResult[];
	disable(pi: ExtensionAPI, sessionManager: BranchReader): ToggleResult[];
	isEnabled(pi: ExtensionAPI): boolean;
}

export interface ToolsetChangedEvent {
	/** Toolset id (e.g. "my-plugin.web"). Always set. */
	id: string;
	enabled: boolean;
}

/**
 * How toolsets with no persisted branch entry resolve on restore.
 */
export type DefaultResolutionMode = "exclusion" | "allowlist";

// ---------------------------------------------------------------------------
// Change notification — event names
// ---------------------------------------------------------------------------

/** Event names for toolset change notification. Restore emits `changed`
 *  for default-fallback toolsets under exclusion, but `restored` for every
 *  registered toolset under allowlist (a branch replay, not a live toggle).
 *  The `requires` cascade is not re-run during allowlist restore — pass the
 *  forward closure. */
export const TOOLSET_EVENTS = {
	changed: "toolset:changed",
	restored: "toolset:restored",
} as const;

// ---------------------------------------------------------------------------
// Registry on globalThis
// ---------------------------------------------------------------------------

const REGISTRY_KEY = "__piToolMaskingRegistry";
const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";
const HANDLERS_KEY = "__piToolMaskingHandlerInstalled";
// Tracks which pi instances have had the restore/re-assert handlers installed.
// `defineToolset` calls `ensureRestoreHandler` once per toolset; keying the
// de-dup on the pi object (not a global boolean) keeps turn-boundary work at
// O(toolsets) per turn across N toolsets sharing one pi, while still re-
// installing for a fresh pi after `/reload` (new object identity → new
// WeakSet entry). Lives on globalThis like the registry: two extensions
// bundling separate copies of this library share one pi, and the dedup must
// be per (pi, process), not per module copy.
function getHandlerInstalled(): WeakSet<ExtensionAPI> {
	if (
		!(HANDLERS_KEY in globalThis) ||
		!((globalThis as any)[HANDLERS_KEY] instanceof WeakSet)
	) {
		(globalThis as any)[HANDLERS_KEY] = new WeakSet();
	}
	return (globalThis as any)[HANDLERS_KEY] as WeakSet<ExtensionAPI>;
}

export interface RegistryEntry {
	spec: ToolsetSpec;
	toolset: Toolset;
}

type Registry = Map<string, RegistryEntry>;

function getRegistry(): Registry {
	if (
		!(REGISTRY_KEY in globalThis) ||
		!((globalThis as any)[REGISTRY_KEY] instanceof Map)
	) {
		(globalThis as any)[REGISTRY_KEY] = new Map();
	}
	return (globalThis as any)[REGISTRY_KEY] as Registry;
}

// ---------------------------------------------------------------------------
// Branch persistence keys (library-level, not per-consumer)
// ---------------------------------------------------------------------------

const MODE_PERSIST_KEY = "toolset-resolution-mode";

/** Child-defer signal: value is the publisher's pid (string). Static pid tag
 * — no payload, no per-toolset data. Set by a defer-policy parent at
 * restore, inherited by spawned children via the default parent env. */
const DEFER_ENV = "PI_TOOLMASKING_DEFER";
/** True when a FOREIGN pid defer tag is set (an ancestor suspended
 *  governance here); absent, empty, or our own pid all mean enforce —
 *  fail-closed. Env-only, never settings. See README §isDeferredChild. */
export function isDeferredChild(): boolean {
	const v = process.env[DEFER_ENV];
	return v !== undefined && v !== "" && v !== String(process.pid);
}
/** GlobalThis flag key deduping the invalid-childPolicy-value warn, once per
 * process (lives on globalThis — survives /reload). */
const CHILD_POLICY_WARNED_KEY = "__piToolMaskingChildPolicyWarned";

// ---------------------------------------------------------------------------
// Registered tool names — hoisted scan shared by mask/re-assert/apply paths
// ---------------------------------------------------------------------------

/** One getAllTools() pass collecting tools that can actually be active:
 *  registered and not `hidden`-exposure. The cast keeps consumers whose pi
 *  types pre-date `exposure` compiling (this library ships raw TS). */
function getActuatableNames(pi: ExtensionAPI): Set<string> {
	const actuatable = new Set<string>();
	for (const tool of pi.getAllTools()) {
		if ((tool as { exposure?: string }).exposure === "hidden") continue;
		actuatable.add(tool.name);
	}
	return actuatable;
}

// ---------------------------------------------------------------------------
// Compute the desired active-tool list under allowlist mode
// ---------------------------------------------------------------------------
// current − (non-allowlisted members) + (allowlist members), restricted to
// actuatable tools (registered and not `hidden`-exposure). Mirrored by
// doRestore's allowlist branch and reassertAllowlist so the two NEVER drift on
// the mask definition; both call sites pass `getActuatableNames`.
function computeAllowlistDesired(
	allowlist: readonly string[],
	current: readonly string[],
	actuatable: ReadonlySet<string>,
	registry: Registry,
): string[] {
	const allow = new Set<string>(allowlist);
	const suppress = new Set<string>();
	for (const [, entry] of registry) {
		if (!allow.has(entry.spec.id)) {
			for (const n of entry.spec.names) suppress.add(n);
		}
	}
	const desired = new Set<string>();
	for (const n of current) {
		if (!suppress.has(n)) desired.add(n);
	}
	for (const [, entry] of registry) {
		if (allow.has(entry.spec.id)) {
			for (const n of entry.spec.names) desired.add(n);
		}
	}
	return [...desired].filter((n) => actuatable.has(n));
}

/** Do two tool-name lists contain exactly the same names (order-insensitive)?
 *  The shared allowlist delta gate — length alone can't tell "no drift" from
 *  "a leak removed AND a member re-added". */
function isSameNameSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const bSet = new Set(b);
	return a.every((n) => bSet.has(n));
}

// ---------------------------------------------------------------------------
// Persisted resolution state — one branch read shared by restore, the turn
// re-assert's arm selection, the exported resolver, the toggle refusal, and
// the exported decision read, so all five can never drift on what the
// persisted mode is
// ---------------------------------------------------------------------------

/** Persisted resolution state from the branch's LAST mode entry.
 *  Unrecognized modes → `"exclusion"`; a corrupt allowlist recovers fail-
 *  closed — a non-array to EMPTY, non-string members dropped ("everything
 *  on" is the wrong recovery for a masking library). Write-time validation is the
 *  asymmetric mirror: `setDefaultResolutionMode` rejects an empty array,
 *  restore recovers it. A governance decision/authoring read, NEVER a
 *  toggle pre-check — call the toggle and catch `AllowlistModeError`.
 *  Copy-on-read: the returned array is fresh; branch data is never aliased.
 */
export function readBranchModeState(branch: readonly SessionEntry[]): {
	mode: DefaultResolutionMode;
	allowlist: string[];
} {
	const last = lastCustomEntry<
		{
			// persisted data — legacy branches may carry unrecognized mode values
			mode?: string;
			allowlist?: string[];
		} | null
	>(branch, MODE_PERSIST_KEY);
	const rawAllowlist = last?.data?.allowlist;
	return {
		mode: last?.data?.mode === "allowlist" ? "allowlist" : "exclusion",
		// Copy on read: never hand out a reference into the branch entry data.
		// Drop non-string members (hand-edited corruption) so the `string[]`
		// return type holds — no id matches a non-string, still fail-closed.
		allowlist: Array.isArray(rawAllowlist)
			? rawAllowlist.filter((v): v is string => typeof v === "string")
			: [],
	};
}

// ---------------------------------------------------------------------------
// Effective-enabled resolution — shared by restore and the turn re-assert
// ---------------------------------------------------------------------------

/**
 * Resolve a toolset's effective enabled state through the same tier chain
 * restore applies: chat-branch entry → settings pin → `defaultEnabled ?? true`
 * (`settingsDefaults` in the on-disk shape `readMergedToolsetDefaults()`
 * returns; a null tombstone falls through like no entry). Allowlist-aware:
 * when the branch's mode entry says `"allowlist"`, the allowlist is
 * authoritative and the ledger is bypassed — the read is mode-dependent by
 * design. `persistedEntry` is true only when the last branch entry carries
 * a boolean `enabled`; restore uses it to pick the `restored` vs `changed`
 * emit.
 *
 * @public — display surfaces read `.enabled` (`branch` from
 * `ctx.sessionManager.getBranch()` inside a handler); never use it to gate
 * a toggle — call the toggle and catch.
 */
export function effectiveEnabled(
	spec: ToolsetSpec,
	branch: readonly SessionEntry[],
	settingsDefaults: ToolsetDefaultsMap,
): { enabled: boolean; persistedEntry: boolean } {
	const { mode, allowlist } = readBranchModeState(branch);
	if (mode === "allowlist") {
		const lastEntry = lastCustomEntry<{ enabled?: boolean } | null>(
			branch,
			spec.persistKey,
		);
		return {
			enabled: allowlist.includes(spec.id),
			persistedEntry: typeof lastEntry?.data?.enabled === "boolean",
		};
	}
	return resolveExclusionTier(spec, branch, settingsDefaults);
}

/** Exclusion tier chain: chat-branch entry → settings pin → packaged
 *  `defaultEnabled ?? true`. Internal call sites (`effectiveEnabled`'s
 *  exclusion path, restore's per-toolset loop, the exclusion re-assert,
 *  `executeBatchPlan`'s delta basis, `getEffectiveDefault` via an empty
 *  branch) use this directly — mode is loop-invariant and already
 *  resolved to exclusion at those sites, so re-reading the branch mode
 *  entry per toolset would be wasted work. */
function resolveExclusionTier(
	spec: ToolsetSpec,
	branch: readonly SessionEntry[],
	settingsDefaults: ToolsetDefaultsMap,
): { enabled: boolean; persistedEntry: boolean } {
	const lastEntry = lastCustomEntry<{ enabled?: boolean } | null>(
		branch,
		spec.persistKey,
	);
	const enabled = lastEntry?.data?.enabled;
	if (typeof enabled === "boolean") {
		return { enabled, persistedEntry: true };
	}
	const settingsEnabled = settingsDefaults[spec.persistKey]?.enabled;
	const resolved =
		typeof settingsEnabled === "boolean"
			? settingsEnabled
			: (spec.defaultEnabled ?? true);
	return { enabled: resolved, persistedEntry: false };
}

// ---------------------------------------------------------------------------
// Ensure session_start / session_tree restore handler is registered once
// per pi (WeakSet), with a second runtime dedup by event-object identity
// ---------------------------------------------------------------------------

function ensureRestoreHandler(pi: ExtensionAPI): void {
	// Install once per pi instance (see getHandlerInstalled above).
	if (getHandlerInstalled().has(pi)) return;
	getHandlerInstalled().add(pi);

	// Dedup by event-object identity. The runner passes the same event
	// reference to every extension's handler in one emit() call, so the first
	// handler wins and the rest skip. Each /reload constructs a fresh event
	// object, so restore re-runs with the fresh pi.
	const doRestore = (event: unknown, ctx: ExtensionContext): void => {
		if ((globalThis as any)[RESTORE_EVENT_KEY] === event) return;
		(globalThis as any)[RESTORE_EVENT_KEY] = event;

		const registry = getRegistry();

		// ---- Child-policy defer: read + publish/consume ----
		// MUST run at the TOP, before the allowlist short-circuit: the allowlist
		// branch returns below without reaching the settings read, so a policy
		// read placed after mode resolution would make allowlist-mode parents
		// never publish (children fall back to enforcing — fail-closed but wrong).
		// The var is a static pid tag; no per-tool_call work, no delta gating.
		const policy = readChildPolicy();
		const deferVar = process.env[DEFER_ENV];
		const deferring = policy === "defer" && isDeferredChild();

		if (policy === "defer") {
			// Absent OR EMPTY both publish: an empty value is garbage no
			// producer writes, not a deliberate foreign defer tag — overwrite it
			// with our own pid and enforce. Keeps both checks in lockstep.
			if (deferVar === undefined || deferVar === "") {
				// Top-level parent: publish once per restore. A foreign var is left
				// UNTOUCHED (no republish) — overwriting it with our own pid would
				// stop us deferring at the next restore (/new, /resume, session_tree
				// all stay in-process), silently flipping to enforcing mid-session.
				// Env inheritance already delivers the parent's pid to grandchildren.
				process.env[DEFER_ENV] = String(process.pid);
			}
		} else {
			// Opt-out ("settings"): delete an inherited var so the un-defer is
			// subtree-effective — a default-defer grandchild of this child starts
			// clean and publishes its own var.
			delete process.env[DEFER_ENV];
		}

		if (deferring) {
			// Child deferring to its spawner: skip EVERYTHING — mode resolution,
			// the allowlist short-circuit, and the per-toolset loop (both the
			// settings tier AND the branch tier — our own branch entries must not
			// apply either). No restored/changed events.
			return;
		}

		// Re-read durable resolution mode before per-toolset fallback.
		// setDefaultResolutionMode persists this bit; a fresh process defaults
		// to "exclusion" until the persisted entry is replayed here. Mode
		// entries are from a prior session (not written during this restore), so
		// a single read here is sufficient. The read + normalization + fail-
		// closed allowlist recovery live in `readBranchModeState` — the same
		// helper the exported `effectiveEnabled` uses, so restore and the
		// resolver cannot drift on what the persisted mode is.
		const { mode, allowlist: allowArr } = readBranchModeState(
			ctx.sessionManager.getBranch(),
		);

		// Allowlist short-circuit: the allowlist is a finite array of
		// toolset ids stored in the branch mode entry; the suppression (the
		// complement) is COMPUTED here over all registered toolsets, not stored.
		// While the last mode entry is "allowlist", this set-level override is
		// authoritative: per-toolset branch entries and settings pins are
		// bypassed, and toolsets registered after the mode entry are off.
		// Atomic two-phase restore: phase 1 computes the desired active-tools
		// set and applies it in ONE `setActiveTools` call (no per-toolset emit
		// during the loop — a companion mirror on `changed` cannot fire
		// mid-restore and `appendEntry` against an in-progress state); phase 2
		// emits `restored` for every registered toolset AFTER state is final.
		if (mode === "allowlist") {
			// `allowArr` computed above — fail-closed `[]` recovery already applied.
			const allow = new Set<string>(allowArr);

			// Phase 1: desired set = current − (suppressed toolset members) +
			// (allowlist members), via the shared helper. The suppress set is the
			// complement of the allowlist among registered toolset tools only;
			// everything else in the current set (tools not owned by any registered
			// toolset) is kept as-is — `setActiveTools` is a full replacement, so we
			// must not rebuild the set from only allowlist members.
			const current = pi.getActiveTools();
			const actuatable = getActuatableNames(pi);
			const desired = computeAllowlistDesired(
				allowArr,
				current,
				actuatable,
				registry,
			);
			if (!isSameNameSet(desired, current)) {
				pi.setActiveTools(desired);
			}

			// Phase 2: notify AFTER state is final. `restored` for every
			// registered toolset — the whole pass is a branch replay of the
			// authoritative allowlist entry, not a live toggle (see the restore
			// contract on `TOOLSET_EVENTS` for the event-type divergence by mode).
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

		// Read settings.json toolset defaults once per restore pass.
		// settings.json is stable mid-restore (unlike the branch, which
		// companion mirroring can mutate), so a single read suffices.
		const settingsDefaults = readMergedToolsetDefaults();

		// ponytail: restore applies each toolset's entry independently and does
		// NOT re-run the requires cascade. Safe because persisted state is always
		// consistent — the live-toggling cascade makes an
		// incoherent persisted combo unreachable. Re-adding cascade here would
		// double-toggle and break restore independence.
		//
		// Re-read the branch per toolset (not once before the loop): a companion
		// mirror fires synchronously inside `_applyRestoreToolset` and may
		// `appendEntry` for a toolset later in iteration order (e.g. my-plugin.web's
		// default-false restore makes search.web disable itself). Snapshotting the
		// branch once would hide that write from the later toolset, so it would
		// fall back to its packaged default and desync from the companion — the
		// "search's own restore reads the branch and finds the entry the mirror
		// just wrote" guarantee.
		for (const [, entry] of registry) {
			const { spec } = entry;

			// Find persisted entry for this toolset (last-writer-wins).
			// Fresh read per toolset so companion-mirror writes during this
			// pass are visible to later toolsets. The `b.data != null` filter
			// is dropped: a null (tombstoned) last entry means "cleared →
			// fall through to settings → packaged" and must beat a stale prior
			// entry instead of being invisible. The tier chain
			// itself lives in `resolveExclusionTier` — shared with the
			// turn-boundary re-assert so the two can never drift. (Exclusion
			// is already resolved above; the allowlist branch returns before
			// this loop, so the per-toolset mode read would be wasted work.)
			const branchNow = ctx.sessionManager.getBranch();
			const { enabled, persistedEntry } = resolveExclusionTier(
				spec,
				branchNow,
				settingsDefaults,
			);
			_applyRestoreToolset(spec, pi, enabled, persistedEntry);
		}
	};

	pi.on("session_start", doRestore);
	pi.on("session_tree", doRestore);

	// Re-assert the allowlist at every turn boundary. While allowlist mode is
	// active, the allowlist is only enforced on session_start /
	// session_tree (above). Between those events, any extension that calls
	// `pi.setActiveTools` directly mid-session punches straight through — e.g.
	// a `before_agent_start` reconciler force-adding its tool or force-removing
	// a permit-list member. This handler defends the mask at each turn,
	// undoing BOTH directions of drift (leak + force-removal) via the same
	// shared `computeAllowlistDesired` definition the restore path uses.
	const reassertAllowlist = (allow: string[]): void => {
		const registry = getRegistry();
		const current = pi.getActiveTools();
		const currentSet = new Set(current);
		const actuatable = getActuatableNames(pi);
		const next = computeAllowlistDesired(allow, current, actuatable, registry);
		// Delta gate — no-op unless the active set actually changed.
		if (isSameNameSet(next, current)) {
			return;
		}
		pi.setActiveTools(next);
		// Emit `changed` so downstream slots (tbox status bar) re-render to the
		// corrected count. One emit per affected toolset, keyed to ACTUAL drift:
		// allowlist members restored (`enabled: true`) are the names in `next` but
		// not `current`; leaks removed (`enabled: false`) are the names in
		// `current` but not `next`. Comparing to the applied sets, not raw spec
		// names, avoids false emits for allowlisted names whose tools aren't
		// registered (forward references) — they can't be restored, so they
		// must not claim a restoration.
		const nextSet = new Set(next);
		for (const [, entry] of registry) {
			const names = [...entry.spec.names];
			if (allow.includes(entry.spec.id)) {
				if (names.some((n) => nextSet.has(n) && !currentSet.has(n))) {
					_emitToolsetEvents(entry.spec, pi, TOOLSET_EVENTS.changed, true);
				}
			} else if (names.some((n) => currentSet.has(n) && !nextSet.has(n))) {
				_emitToolsetEvents(entry.spec, pi, TOOLSET_EVENTS.changed, false);
			}
		}
	};

	// Non-allowlist mode (exclusion — the default): the DISABLED set is a
	// hard constraint — `enabled: false`
	// means "these tools must be off". Between restore events, a raw
	// `pi.setActiveTools` call from another extension's reconciler punches
	// straight through a disabled toolset and the force-add survives into
	// the turn. This handler defends the LEAK direction at each turn:
	// force-re-added tools of a toolset whose EFFECTIVE state is off are
	// removed again. Effective state goes through the same tier chain
	// restore uses (`resolveExclusionTier`), so this can never disagree with
	// what restore would apply after a `/reload` — no turn-to-turn
	// flip-flop. Leak-direction only: a default-on toolset is not a hard
	// constraint — a missing default-on tool may have been intentionally
	// removed, so it is not force-restored. (An explicit `enabled: true`
	// branch entry IS user intent but is equally unprotected from
	// force-removal; force-removal reconcilers are rarer than force-add
	// ones and this has not been reported.)
	const reassertDisabled = (branch: readonly SessionEntry[]): void => {
		const registry = getRegistry();
		const current = pi.getActiveTools();

		// Settings read once per turn; same tier chain as restore. The branch
		// is threaded in from the dispatcher — the mode decision and the tier
		// chain are provably made against the same snapshot (one getBranch()
		// read per turn).
		const settingsDefaults = readMergedToolsetDefaults();

		// Suppress set = union of names over toolsets whose effective state
		// is off.
		const suppress = new Set<string>();
		for (const [, entry] of registry) {
			// Exclusion mode is established by the dispatcher (this function is
			// only reached when the branch's mode entry resolves to exclusion),
			// so the tier chain is used directly — no per-toolset mode re-read.
			const { enabled } = resolveExclusionTier(
				entry.spec,
				branch,
				settingsDefaults,
			);
			if (!enabled) {
				for (const n of entry.spec.names) suppress.add(n);
			}
		}

		const next = current.filter((n) => !suppress.has(n));
		// Delta gate — no-op unless the active set actually changed. `next` is
		// a filter of `current`, so equal length already implies equality
		// (unlike reassertAllowlist's gate, where same-length different sets
		// are possible and the containment check is load-bearing).
		if (next.length === current.length) {
			return;
		}
		pi.setActiveTools(next);
		// Emit `changed` so downstream slots (tbox status bar) re-render to the
		// corrected count. One emit per affected toolset, keyed to ACTUAL
		// drift: names in `current` but not `next` (leak direction). The
		// `currentSet.has(n)` guard skips toolsets whose names were never
		// active — removing nothing is not drift, so no false `changed`.
		const currentSet = new Set(current);
		const nextSet = new Set(next);
		for (const [, entry] of registry) {
			const names = [...entry.spec.names];
			if (names.some((n) => currentSet.has(n) && !nextSet.has(n))) {
				_emitToolsetEvents(entry.spec, pi, TOOLSET_EVENTS.changed, false);
			}
		}
	};

	// Single dispatcher: branch on defer + mode, NOT a second `pi.on`
	// registration — the suite asserts `handlerCount("before_agent_start") ===
	// 1`. One registration, the defer guard and two mode-shaped re-asserters
	// behind it.
	const onBeforeAgentStart = (_event: unknown, ctx: ExtensionContext): void => {
		// Deferring child: no re-assert at all — the spawner owns the child's
		// tools for the session, on BOTH dispatch paths (a resumed child branch
		// could carry an allowlist mask; the dispatcher placement guarantees it
		// is guarded rather than hoping fresh branches carry no mode entries).
		// Never reads settings here, so deferring children shed the per-turn IO.
		if (isDeferredChild()) return;

		// Arm selection reads the branch — the same shared read restore, the
		// resolver, and the toggle refusal use. No module-state mirror
		// participates: a mirror lags the branch whenever a mode entry is
		// appended without the module write (e.g. a raw append in a fresh
		// process before its first restore — there the branch read enforces the
		// allowlist from the first turn instead of running the exclusion
		// re-assert over allowlisted state). Fail-open/fail-closed edge cases
		// (absent entry → exclusion, corrupt allowlist → fail-closed: non-array
		// → `[]`, non-string members dropped) come with
		// `readBranchModeState`'s contract and now govern this call site. The
		// snapshot is threaded to the exclusion arm, so one getBranch() read
		// covers the whole turn.
		const branch = ctx.sessionManager.getBranch();
		const { mode, allowlist } = readBranchModeState(branch);
		if (mode === "exclusion") {
			reassertDisabled(branch);
		} else {
			reassertAllowlist(allowlist);
		}
	};

	// ponytail: re-assert runs at this extension's load-order position. If a
	// force-add reconciler on another extension loads AFTER this consumer,
	// it re-adds after us and the leak survives. Fully-robust fix needs a
	// pi-core masking primitive at the setActiveTools boundary.
	//
	// ponytail: reassertDisabled computes effective state from the branch,
	// like restore — so a live-applied disable with no branch entry
	// (`forceToolsetEnabled(pi, spec, false)`) is not defended. By design
	// (the re-assert must not drift from restore); that API is used in the
	// allowlist restore path, not for interactive exclusion-mode toggles.
	pi.on("before_agent_start", onBeforeAgentStart);
}

// ---------------------------------------------------------------------------
// Event emission helper
// ---------------------------------------------------------------------------

function _emitToolsetEvents(
	spec: ToolsetSpec,
	pi: ExtensionAPI,
	eventType: string,
	enabled: boolean,
): void {
	pi.events.emit(eventType, { id: spec.id, enabled });
}

// ---------------------------------------------------------------------------
// Helper: last custom entry (typed read, no per-site `any` cast)
// ---------------------------------------------------------------------------

/**
 * Last custom entry matching customType, narrowed through the "custom"
 * discriminator so callers get typed `.data` without per-site `any` casts.
 * Scans newest-first (last write wins). Returns the entry even when
 * `data` is null/undefined (tombstone) — callers decide how to treat that.
 */
export function lastCustomEntry<T>(
	branch: readonly SessionEntry[],
	customType: string,
): CustomEntry<T> | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e === undefined) continue;
		if (e.type === "custom" && e.customType === customType) {
			return e as CustomEntry<T>;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Shared actuation primitives — loadout writes only; persisting and
// emitting live in executeBatchPlan (toggle path) and _applyRestoreToolset
// (restore path).
// ---------------------------------------------------------------------------

/** Add a toolset's actuatable, not-yet-active members to the active set.
 *  A hidden member can never be active, so the add filters through the
 *  actuatable set — handing one to setActiveTools is a silent drop. A
 *  no-op when next === current (skips the redundant loadout write and
 *  pi's system-prompt rebuild). Returns whether any write occurred. */
function actuateAdd(spec: ToolsetSpec, pi: ExtensionAPI): boolean {
	const current = new Set(pi.getActiveTools());
	const actuatable = getActuatableNames(pi);
	const toAdd = [...spec.names].filter(
		(n) => actuatable.has(n) && !current.has(n),
	);
	if (toAdd.length === 0) return false;
	pi.setActiveTools([...new Set([...current, ...toAdd])]);
	return true;
}

/** Remove a toolset's active members from the active set. Filters by raw
 *  spec.names — a stale-but-active member must be removed even if it is no
 *  longer registered (or is hidden, which can never be active and so removes
 *  nothing). Only the ADDING direction filters through the actuatable set.
 *  A no-op when nothing was removed (avoids handing pi back its own active
 *  list). Returns whether any write occurred. */
function actuateRemove(spec: ToolsetSpec, pi: ExtensionAPI): boolean {
	const current = pi.getActiveTools();
	const filtered = current.filter((n) => !spec.names.has(n));
	if (filtered.length === current.length) return false;
	pi.setActiveTools(filtered);
	return true;
}

// ---------------------------------------------------------------------------
// Restore-specific apply: applies state without persisting, always emits
// isPersistedEntry=true → restored event, false → changed event.
// Inert toolsets apply `enabled` as far as they can (no loadout write) while
// the emit still fires — see the README's hidden-exposure section.
// ---------------------------------------------------------------------------

function _applyRestoreToolset(
	spec: ToolsetSpec,
	pi: ExtensionAPI,
	enabled: boolean,
	isPersistedEntry: boolean,
): void {
	if (enabled) {
		// Shared add-path with the toggle path (actuateAdd): the toAdd guard
		// skips the redundant full-loadout write + system-prompt rebuild when
		// next === current.
		actuateAdd(spec, pi);
	} else {
		// Shared remove-path with the toggle path (actuateRemove) — an
		// unregistered spec member active in the list must be removed on
		// restore just like a manual disable would.
		actuateRemove(spec, pi);
	}

	// Always emit regardless of state (always-emit invariant)
	const eventType = isPersistedEntry
		? TOOLSET_EVENTS.restored
		: TOOLSET_EVENTS.changed;
	_emitToolsetEvents(spec, pi, eventType, enabled);
}

// ---------------------------------------------------------------------------
// Batch planner and executor — pure plan, pre-write throws
// ---------------------------------------------------------------------------

/** One requested toggle in a batch: final desired state for a toolset id. */
export interface BatchOp {
	id: string;
	desired: boolean;
}

/** Pure plan for a batch of toggle ops. `intent` is the resolved final state
 *  per id (explicit targets ∪ cascade closure); `order` is the canonical
 *  write/report/emit order — ops in op order, enable deps-first post-order
 *  over `requires` in declaration order, disable self-first over dependents
 *  in registry order, one global visited set across the whole batch. */
export interface BatchPlan {
	intent: Map<string, boolean>;
	order: string[];
}

/** Cycle in the toggle batch's `requires`/dependents graph — thrown by the
 *  pure planner, before any write. Catch by `err?.name === "CycleError"`,
 *  never `instanceof` (throwers may belong to another library copy).
 *  `cyclePath` (e.g. "A → B → A") is a diagnostic, not contract. */
export class CycleError extends Error {
	/** The discovered cycle path, e.g. "A → B → A". */
	readonly cyclePath: string;

	constructor(cyclePath: string) {
		super(`[pi-tool-masking] Cycle detected: ${cyclePath}`);
		this.name = "CycleError";
		this.cyclePath = cyclePath;
	}
}

/** The batch's resolved intent is incoherent: an id enabled while a
 *  transitive `requires` dependency of it is disabled by the same batch
 *  (conflicting duplicate ops on one id are the zero-hop form). Thrown by
 *  the pure planner, before any write; catch by `err?.name`, never
 *  `instanceof`. Full rule: README §toggleBatch. */
export class ContradictionError extends Error {
	constructor(detail: string) {
		super(`[pi-tool-masking] contradictory toggle batch: ${detail}`);
		this.name = "ContradictionError";
	}
}

/** Pure planner for a batch of toggle ops: resolves explicit targets plus
 *  their cascade closures into a final intent per id and a duplicate-free
 *  write order; throws (CycleError, ContradictionError, unknown id) before
 *  any write. Closure and contradiction semantics: README §toggleBatch.
 *  The `explicitIntent` ledger is load-bearing — every explicit op must
 *  re-record its claim even over an implied value, or a second conflicting
 *  explicit op would overwrite silently instead of throwing.
 *
 * @internal — planner-level tests only; not a public API commitment.
 */
function planBatch(ops: readonly BatchOp[]): BatchPlan {
	const registry = getRegistry();
	const intent = new Map<string, boolean>();
	const explicitIntent = new Map<string, boolean>();
	const order: string[] = [];
	const path: string[] = [];

	const visit = (id: string, desired: boolean, explicit: boolean): void => {
		if (path.includes(id)) {
			// Cycle detected in this traversal, before any write — atomic.
			throw new CycleError([...path, id].join(" \u2192 "));
		}
		if (intent.has(id)) {
			if (!explicit) return; // implied revisit — first pull wins; the
			// closure check below refuses any true/false disagreement
			const claimed = explicitIntent.get(id);
			if (claimed === undefined) {
				// Explicit beats implied. The closure check below refuses the
				// override whenever it breaks the coherence invariant. Record the
				// claim too — every explicit write to intent updates the ledger,
				// or a second conflicting explicit op would overwrite silently
				// instead of throwing (and would erase the intermediate state the
				// coherence pass could have caught).
				intent.set(id, desired);
				explicitIntent.set(id, desired);
			} else if (claimed !== desired) {
				// Conflicting explicit ops on one id — the zero-hop contradiction.
				throw new ContradictionError(
					`"${id}" is requested as both enabled and disabled`,
				);
			}
			return;
		}
		const entry = registry.get(id);
		if (!entry) {
			if (explicit) {
				throw new Error(
					`[pi-tool-masking] unknown toolset id "${id}" in toggle batch`,
				);
			}
			return; // implied unregistered dep — lenient skip (forward reference)
		}
		if (explicit) explicitIntent.set(id, desired);
		path.push(id);
		if (desired) {
			// Enable: deps first (post-order over `requires`, declaration order).
			for (const depId of entry.spec.requires ?? []) {
				visit(depId, true, false);
			}
			path.pop();
			intent.set(id, desired);
			order.push(id);
		} else {
			// Disable: self first (pre-order), then dependents in registry order.
			intent.set(id, desired);
			order.push(id);
			for (const [dependentId, depEntry] of registry) {
				if (depEntry.spec.requires?.includes(id)) {
					visit(dependentId, false, false);
				}
			}
			path.pop();
		}
	};

	for (const op of ops) visit(op.id, op.desired, true);

	// Coherence invariant over transitive closures: an enabled id must not
	// depend (transitively) on a disabled id. The walk only traverses
	// requires edges already covered by the traversal above, so it is
	// cycle-free by construction (cycles threw as CycleError).
	for (const [id, desired] of intent) {
		if (!desired) continue;
		const seen = new Set<string>([id]);
		const stack = [...(registry.get(id)?.spec.requires ?? [])];
		while (stack.length > 0) {
			const depId = stack.pop() as string;
			if (seen.has(depId)) continue;
			seen.add(depId);
			const dep = registry.get(depId);
			if (!dep) continue; // unregistered implied dep — lenient skip
			if (intent.get(depId) === false) {
				throw new ContradictionError(
					`"${id}" would be enabled but its requirement "${depId}" is disabled by the same batch`,
				);
			}
			stack.push(...(dep.spec.requires ?? []));
		}
	}

	return { intent, order };
}

/** Execute a plan from {@link planBatch} — the sole toggle actuation path.
 *  Derives the delta's `before` basis from the caller's threaded branch +
 *  settings snapshots (one read per public call, never re-read) and
 *  persists/emits only ids whose intent differs from `before` or whose
 *  loadout wrote; emits fire only after all writes, in `plan.order`. A
 *  racing external append (e.g. a prepareLoadout hook) for an id whose
 *  intent already matched is neither repaired nor reported — it wins at
 *  the next restore by last-writer-wins.
 *
 * @internal — executor-level tests only; not a public API commitment.
 */
function executeBatchPlan(
	plan: BatchPlan,
	pi: ExtensionAPI,
	branch: readonly SessionEntry[],
	defaults: ToolsetDefaultsMap,
): ToggleResult[] {
	const registry = getRegistry();
	// Pre-call resolved state from the ONE threaded snapshot — the delta's
	// basis. Exclusion tier directly: the boundary already established
	// exclusion mode (allowlist throws before planning).
	const before = new Map<string, boolean>();
	for (const id of plan.intent.keys()) {
		// plan.intent only holds registered ids (planBatch throws on explicit
		// unknowns and skips implied ones), and the registry only grows.
		const entry = registry.get(id) as RegistryEntry;
		before.set(id, resolveExclusionTier(entry.spec, branch, defaults).enabled);
	}

	const results: ToggleResult[] = [];
	// plan.order is duplicate-free by planner construction (its `intent.has`
	// guard is the global visited set), so each id is actuated exactly once.
	for (const id of plan.order) {
		const entry = registry.get(id) as RegistryEntry;
		const desired = plan.intent.get(id) === true;
		// Loadout write — the delta gate's second disjunct.
		const wrote = desired ? actuateAdd(entry.spec, pi) : actuateRemove(entry.spec, pi);
		if (before.get(id) === desired && !wrote) continue; // silent repeat
		pi.appendEntry(entry.spec.persistKey, { enabled: desired });
		results.push({ id, enabled: desired });
	}

	// Post-execution emits — results are in plan.order, so the event order
	// matches the write/report order. No library event has fired until now.
	for (const result of results) {
		const entry = registry.get(result.id) as RegistryEntry;
		_emitToolsetEvents(entry.spec, pi, TOOLSET_EVENTS.changed, result.enabled);
	}
	return results;
}

// ---------------------------------------------------------------------------
// AllowlistModeError — the toggle boundary's refusal type
// ---------------------------------------------------------------------------

/** Thrown when a toggle runs under allowlist governance; atomic — the
 *  throw precedes the cascade (nothing written, nothing emitted). Catch
 *  by `err?.name`, never `instanceof` (throwers may belong to another
 *  library copy — deliberately unlike {@link MalformedSettingsError}). */
export class AllowlistModeError extends Error {
	/** The refused toolset's spec.id — set on single-op refusals (the
	 *  {@link Toolset.enable}/`.disable` wrappers), absent on batch-path
	 *  refusals (mode-global, attributes nothing). */
	specId?: string;

	constructor(specId?: string) {
		super(
			specId !== undefined
				? `[pi-tool-masking] enable/disable refused for "${specId}" in allowlist mode — the allowlist/focus set governs toolset state.`
				: `[pi-tool-masking] toggle batch refused in allowlist mode — the allowlist/focus set governs toolset state.`,
		);
		this.name = "AllowlistModeError";
		if (specId !== undefined) this.specId = specId;
	}
}

/** Internal toggle boundary; the full contract (gate order, refusal
 *  classes, delta semantics) lives on the public {@link toggleBatch} and
 *  applies verbatim — `refusalSpecId` is only the single-op wrappers'
 *  attribution, so the wrappers and the batch path share this one
 *  implementation and cannot diverge. */
function runBatch(
	pi: ExtensionAPI,
	sessionManager: BranchReader,
	ops: readonly BatchOp[],
	refusalSpecId?: string,
): ToggleResult[] {
	if (isDeferredChild()) return [];
	if (ops.length === 0) return [];
	const branch = sessionManager.getBranch();
	if (readBranchModeState(branch).mode === "allowlist") {
		throw new AllowlistModeError(refusalSpecId);
	}
	// Plan first (pure, throws on cycles/contradictions/unregistered ids
	// before any read or write beyond the boundary's), then snapshot settings
	// and execute against the threaded branch value.
	const plan = planBatch(ops);
	const defaults = readMergedToolsetDefaults();
	return executeBatchPlan(plan, pi, branch, defaults);
}

/**
 * Toggle a batch of toolsets in one call — the sole toggle actuation path;
 * {@link Toolset.enable}/`.disable` are one-line single-op wrappers
 * delegating here, so they cannot diverge from it.
 *
 * Gate order (every refusal atomic — nothing written, nothing emitted):
 * defer → empty `ops` → allowlist refusal → plan → settings snapshot →
 * execute. A deferring child returns `[]` before the mode check; an empty
 * `ops` array returns `[]` before the mode check in every governance mode
 * (an empty batch requests nothing). Under allowlist governance the whole
 * batch is refused in one throw — a mode-global refusal carries no id
 * (`err.specId === undefined`); consumers render the refusal from their
 * own op list.
 *
 * Throws, all caught by `err?.name === ...` (never `instanceof` — throwers
 * may belong to a different physical copy of this library), messages are
 * diagnostics and never string-matched:
 * - {@link AllowlistModeError} — allowlist governance (mode-global, no
 *   `specId` on this path)
 * - {@link CycleError} — any cycle reachable from any op, before any write
 * - {@link ContradictionError} — the resolved intent is incoherent (an id
 *   enabled while a transitive `requires` dependency of it is disabled by
 *   the same batch; conflicting duplicate ops on one id are the zero-hop
 *   form)
 * - a plain `Error` — an explicit op naming an unregistered id (a
 *   deliberate claim by the caller; implied closure deps that are
 *   unregistered stay leniently skipped — forward references are
 *   tolerated). Duplicate ops with the same `desired` dedupe silently.
 *
 * One batch is one coherent intent: the planner resolves explicit targets
 * plus their cascade closures into a final state per id, and the result is
 * a flattened intent delta — one {@link ToggleResult} per id whose final
 * state differs from the pre-call resolved state or whose loadout wrote
 * (an op already in its desired state is absent from the result). No
 * library-emitted event fires until every write has completed; emits fire
 * once, in the planner's discovery order. Sequences that disable a
 * dependency while enabling something that requires it (e.g. "disable
 * all, then enable the unit") must stay two calls — one batch would
 * refuse the conflict as a contradiction.
 */
export function toggleBatch(
	pi: ExtensionAPI,
	sessionManager: BranchReader,
	ops: readonly BatchOp[],
): ToggleResult[] {
	return runBatch(pi, sessionManager, ops);
}

class ToolsetImpl implements Toolset {
	constructor(private readonly spec: ToolsetSpec) {}

	enable(pi: ExtensionAPI, sessionManager: BranchReader): ToggleResult[] {
		// One-line sugar over the sole toggle path — cannot diverge from it.
		return runBatch(
			pi,
			sessionManager,
			[{ id: this.spec.id, desired: true }],
			this.spec.id,
		);
	}

	disable(pi: ExtensionAPI, sessionManager: BranchReader): ToggleResult[] {
		return runBatch(
			pi,
			sessionManager,
			[{ id: this.spec.id, desired: false }],
			this.spec.id,
		);
	}

	isEnabled(pi: ExtensionAPI): boolean {
		const active = new Set(pi.getActiveTools());
		return [...this.spec.names].some((n) => active.has(n));
	}
}

/**
 * Error thrown by {@link defineToolset} when a different registered toolset
 * already claims the spec's `persistKey` (two toolsets sharing one persistKey
 * would fight over the same persisted intent entries). Registration writes
 * nothing, so the throw is atomic. Carries the colliding `persistKey` and the
 * `existingId` that owns it. Catch with
 * `err?.name === "PersistKeyCollisionError"`, NOT `instanceof` — same
 * rationale as {@link AllowlistModeError} (throwers may belong to a different
 * physical copy of this library). The message is a diagnostic, not contract:
 * never string-match it.
 */
export class PersistKeyCollisionError extends Error {
	/** The persistKey two different toolset ids are claiming. */
	readonly persistKey: string;
	/** The spec.id of the already-registered toolset that owns the persistKey. */
	readonly existingId: string;

	constructor(persistKey: string, existingId: string) {
		super(
			`[pi-tool-masking] persistKey collision: "${persistKey}" is already used by toolset "${existingId}"`,
		);
		this.name = "PersistKeyCollisionError";
		this.persistKey = persistKey;
		this.existingId = existingId;
	}
}

// ---------------------------------------------------------------------------
// Public API — functions
// ---------------------------------------------------------------------------

export function defineToolset(pi: ExtensionAPI, spec: ToolsetSpec): Toolset {
	if (typeof spec.id !== "string" || spec.id.trim() === "") {
		throw new Error("[pi-tool-masking] spec.id must be a non-empty string");
	}
	if (typeof spec.persistKey !== "string" || spec.persistKey.trim() === "") {
		throw new Error(
			"[pi-tool-masking] spec.persistKey must be a non-empty string",
		);
	}
	if (spec.persistKey === MODE_PERSIST_KEY) {
		// The mode entry shares this key's entry stream; a toolset toggling
		// under it would supersede the governance entry (last-writer-wins) and
		// vice versa — each write silently corrupting the other's read.
		throw new Error(
			`[pi-tool-masking] spec.persistKey "${MODE_PERSIST_KEY}" is reserved for the resolution-mode branch entry; pick another key.`,
		);
	}

	const registry = getRegistry();
	const existing = registry.get(spec.id);

	if (existing) {
		if (isDeepStrictEqual(existing.spec, spec)) {
			// Idempotent re-registration — return existing toolset.
			// Still register restore handler with current pi (/reload safety).
			ensureRestoreHandler(pi);
			return existing.toolset;
		}
		// Same id, different spec — warn and replace (reload after edit)
		console.warn(
			`[pi-tool-masking] Toolset "${spec.id}" re-registered with a changed spec; replacing (reload after edit).`,
		);
		// fall through to replace
	}

	// Check persistKey collision across all entries (skip self for replace case)
	for (const [id, entry] of registry) {
		if (id !== spec.id && entry.spec.persistKey === spec.persistKey) {
			throw new PersistKeyCollisionError(spec.persistKey, id);
		}
	}

	// Name-overlap guard: no two toolsets may claim the same tool name. Every
	// downstream failure mode (isEnabled lying, restore order-dependence, enable
	// no-op, skipped dependents, allowlist-bypass leaks, mis-attribution, double-counts)
	// requires two toolsets claiming one name; with that unreachable, toolsets
	// own disjoint name sets. Gather every collision in this registration into
	// one error so the author sees the full scope in one pass. `getAllTools()` is
	// deferred to the throw branch so a clean registration never pays for it.
	const collisions: { name: string; owner: string }[] = [];
	for (const [id, entry] of registry) {
		if (id === spec.id) continue;
		for (const name of spec.names) {
			if (entry.spec.names.has(name)) collisions.push({ name, owner: id });
		}
	}
	if (collisions.length > 0) {
		const allTools = pi.getAllTools();
		const lines = collisions.map(({ name, owner }) => {
			const tool = allTools.find((t) => t.name === name);
			const where = tool
				? ` (registered from ${tool.sourceInfo.path}, source: ${tool.sourceInfo.source})`
				: "";
			return `  - tool "${name}" already claimed by toolset "${owner}"${where}`;
		});
		throw new Error(
			`[pi-tool-masking] name overlap: toolset "${spec.id}" claims tools ` +
				`already owned by another toolset:\n` +
				lines.join("\n") +
				"\n" +
				`Each tool may belong to only one toolset. Naming convention: prefix ` +
				`toolset ids with a stable namespace (<product-family>.<subset>, e.g. "my-plugin.web").`,
		);
	}

	const toolset = new ToolsetImpl(spec);
	registry.set(spec.id, { spec, toolset });

	ensureRestoreHandler(pi);

	return toolset;
}

/**
 * Set how toolsets with no persisted entry resolve on restore:
 * `"exclusion"` (default; fall back to `defaultEnabled ?? true`) or
 * `"allowlist"` (only the listed ids are on; requires a non-empty array).
 * The append is the governance authority switch — the only mode write, read
 * back by restore, the re-assert dispatcher, the resolver, and the toggle
 * boundary ({@link readBranchModeState}). In a deferring child this is
 * validate-then-suppress: invalid input still throws, only the append is
 * suppressed.
 *
 * @throws on an invalid mode string, or `"allowlist"` without a non-empty
 *   array — including in a deferring child.
 */
export function setDefaultResolutionMode(
	pi: ExtensionAPI,
	mode: DefaultResolutionMode,
	allowlist?: string[],
): void {
	if (mode !== "exclusion" && mode !== "allowlist") {
		throw new Error(
			`[pi-tool-masking] Invalid defaultResolutionMode: "${mode}". Must be "exclusion" or "allowlist".`,
		);
	}
	// Write-time validation (asymmetric with restore): an allowlist mode with
	// no/empty array is a likely mistake (deleting the last member and
	// forgetting to switch modes); restore instead recovers a corrupt
	// missing/non-array allowlist to `[]` (fail closed). Write-time validates
	// intent; restore-time picks the safe recovery. Forward references are
	// legal — ids need not be registered yet.
	if (
		mode === "allowlist" &&
		(!allowlist || !Array.isArray(allowlist) || allowlist.length === 0)
	) {
		throw new Error(
			`[pi-tool-masking] defaultResolutionMode "allowlist" requires a non-empty allowlist array of toolset ids.`,
		);
	}
	// Deferring child: validate-then-suppress. The validation above is input
	// validation, not a governance write, so it still throws here; only the
	// branch append below (the governance authority switch) is suppressed,
	// silently.
	if (isDeferredChild()) return;
	// Own the value at the write site: pi stores entry `data` by reference
	// and serializes the branch on flush — it does NOT snapshot on append. A
	// caller mutating the array post-call would otherwise edit persisted
	// governance after the write-time validation above has passed, so the
	// stored value must be masking-owned, not the caller's array. (The same
	// invariant covers the read side: `readBranchModeState` copies on read.)
	// Exclusion entries persist `{ mode }` only (unchanged shape).
	const ownedAllowlist =
		mode === "allowlist" && allowlist ? [...allowlist] : undefined;
	pi.appendEntry(
		MODE_PERSIST_KEY,
		mode === "allowlist" ? { mode, allowlist: ownedAllowlist } : { mode },
	);
}

/**
 * Enumerate every registered toolset in the global registry. The returned
 * array is a copy, but its entries are the **live registry entries** — the
 * runtime-membership mutation mechanism is `entry.spec.names = new Set(next)`
 * (data only: no actuation, no persistence, no event; the per-turn
 * re-assert reads the updated `spec.names`, and `forceToolsetEnabled`
 * reconciles immediately). No membership event exists — re-read rather
 * than cache. No `pi` argument needed. Full caveats: README.
 */
export function getRegisteredToolsets(): readonly RegistryEntry[] {
	return [...getRegistry().values()];
}

// ---------------------------------------------------------------------------
// Tombstone helpers + apply-without-persist
// ---------------------------------------------------------------------------

/**
 * Tombstone a toolset's chat-branch entry: append `null` for `persistKey`
 * so `doRestore` falls through to the settings tier. Dedup'd — no
 * tombstone when the last entry is absent or already cleared. `branch` is
 * the caller's snapshot (`ctx.sessionManager.getBranch()`), since
 * `ExtensionAPI` exposes `appendEntry` but not `sessionManager`.
 *
 * Silent no-op in a deferring child (covers {@link clearAllToolsetEntries},
 * which loops through here); raw `pi.appendEntry` stays available for
 * deliberate ledger writes under defer.
 *
 * ponytail: dedup caps growth at one tombstone per toggle/restore cycle,
 * but many cycles in one session still stack entries. Upgrade path: a
 * pi-core "compact toolset entries" op, out of scope.
 */
export function clearToolsetEntry(
	pi: ExtensionAPI,
	persistKey: string,
	branch: readonly SessionEntry[],
): void {
	// Deferring child: ledger writes are suppressed — silent noop, no read,
	// no tombstone (covers clearAllToolsetEntries too, which loops through
	// here).
	if (isDeferredChild()) return;
	const last = lastCustomEntry<{ enabled?: boolean } | null>(branch, persistKey);
	const data = last?.data;
	// No prior entry, a tombstoned last entry (data null), or a last entry
	// without an `enabled` field → already effectively cleared, skip.
	if (data == null || data?.enabled == null) {
		return;
	}
	pi.appendEntry(persistKey, null);
}

/**
 * Tombstone every registered toolset's chat-branch entry (dedup'd per
 * toolset — never-toggled toolsets get no tombstone). Covers exactly the
 * toolsets in the global registry. `branch` is the caller's
 * `ctx.sessionManager.getBranch()` snapshot (see `clearToolsetEntry`).
 */
export function clearAllToolsetEntries(
	pi: ExtensionAPI,
	branch: readonly SessionEntry[],
): void {
	for (const [, entry] of getRegistry()) {
		clearToolsetEntry(pi, entry.spec.persistKey, branch);
	}
}

/**
 * Apply a toolset's enabled state via `setActiveTools` and emit
 * `TOOLSET_EVENTS.changed` — **without** writing a branch entry, with no
 * cascade or intent gate; call once per spec. Returns `void` by design: it
 * shares the restore path, whose always-emit invariant can never honor the
 * `ToggleResult[]` contract. For an inert toolset (zero actuatable
 * members) the apply no-ops but the `changed` event still fires, and
 * `isEnabled()` stays false until actuatable members exist. The primary
 * actuation path under allowlist governance; stays live in a deferring
 * child (persists nothing, reads no governance source).
 */
export function forceToolsetEnabled(
	pi: ExtensionAPI,
	spec: ToolsetSpec,
	enabled: boolean,
): void {
	_applyRestoreToolset(spec, pi, enabled, false);
}

// ---------------------------------------------------------------------------
// Settings.json reader — toolsetDefaults tier
// ---------------------------------------------------------------------------

/** On-disk settings shape: `toolsetDefaults[persistKey] = { enabled }`.
 *  Exported because it appears in the signatures of exported functions
 *  (`readMergedToolsetDefaults`, `writeToolsetDefaults`,
 *  `getEffectiveDefault`, `effectiveEnabled`). */
export type ToolsetDefaultsMap = Record<string, { enabled: boolean }>;

function settingsPath(scope: "global" | "project"): string {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return scope === "global"
		? join(agentDir, "settings.json")
		: join(process.cwd(), ".pi", "settings.json");
}

/**
 * Parsed settings.json at the read boundary — a plain JSON object, or an
 * empty object on missing/unreadable/malformed file (never-throw policy;
 * non-object parses recover to `{}` before crossing the boundary).
 */
type ParsedSettings = Record<string, unknown>;

/**
 * Read one scope's settings.json as a parsed object, or `{}` on any
 * read/parse failure (never-throw policy — a malformed file contributes
 * `{}` to the merge; only mutators throw `MalformedSettingsError`).
 */
function readSettingsJsonSafe(scope: "global" | "project"): ParsedSettings {
	const path = settingsPath(scope);
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as ParsedSettings;
		}
		return {};
	} catch {
		return {};
	}
}

function readScopeSettings(scope: "global" | "project"): ParsedSettings {
	return readSettingsJsonSafe(scope);
}

/**
 * Extract toolset defaults from a settings.json object.
 *
 * Reads `json.toolsetDefaults` — a map of
 * `{ [persistKey]: { enabled: boolean } }`. Entries whose value isn't a
 * `{ enabled }` shape are dropped silently. Returns the on-disk shape
 * verbatim (no flattening — call sites unwrap via `?.enabled`).
 *
 * @internal
 */
function parseToolsetDefaults(json: unknown): ToolsetDefaultsMap {
	if (!json || typeof json !== "object" || Array.isArray(json)) return {};
	const td = (json as Record<string, unknown>)["toolsetDefaults"];
	if (!td || typeof td !== "object" || Array.isArray(td)) return {};
	const result: ToolsetDefaultsMap = {};
	for (const [key, val] of Object.entries(td as Record<string, unknown>)) {
		// ponytail: only `enabled` is read; extra fields (`label`, etc.) ignored.
		// Add a schema validator if downstreams depend on more fields.
		const valObj = val as Record<string, unknown>;
		if (valObj && typeof valObj["enabled"] === "boolean") {
			result[key] = { enabled: valObj["enabled"] as boolean };
		}
	}
	return result;
}

/**
 * Read and merge `toolsetDefaults` from settings.json (global + project,
 * project wins per entry). Returns the on-disk shape
 * `Record<persistKey, { enabled: boolean }>`; missing/unreadable/malformed
 * files contribute `{}`. Never throws.
 *
 * ponytail: hardcodes the two pi-core settings paths (global
 * `~/.pi/agent/settings.json`, project `<cwd>/.pi/settings.json`) with no
 * configuration knob — if pi-core moves its settings paths or format this
 * breaks. Upgrade path: a pi-core settings-path registry, if one ever appears.
 */
export function readMergedToolsetDefaults(): ToolsetDefaultsMap {
	return {
		...parseToolsetDefaults(readScopeSettings("global")),
		...parseToolsetDefaults(readScopeSettings("project")),
	};
}

/**
 * Read toolset defaults from one settings.json scope (global or project).
 *
 * Returns the raw `toolsetDefaults` block parsed from that scope's file,
 * without merging. Missing/unreadable/malformed files return `{}`.
 *
 * @public — exported for a `defaults show`-style command that needs
 * per-scope attribution.
 */
export function readToolsetDefaults(
	scope: "global" | "project",
): ToolsetDefaultsMap {
	return parseToolsetDefaults(readScopeSettings(scope));
}

/** Valid values for `piToolMasking.childPolicy`. */
type ChildPolicy = "defer" | "settings";

/**
 * Read `piToolMasking.childPolicy` from settings (global, then project).
 * Precedence is SCALAR per scope, project wins — the objects are never
 * spread-merged, or a project `"piToolMasking": {}` would silently drop a
 * global `childPolicy`. Never throws; a present-but-invalid value warns
 * once per process and is treated as absent; key absent → `"defer"`. Read
 * once per restore — the per-turn re-assert path never calls this.
 *
 * @internal
 */
function readChildPolicy(): ChildPolicy {
	const read = (
		scope: "global" | "project",
	): Record<string, unknown> | undefined => {
		const pim = readScopeSettings(scope)["piToolMasking"];
		if (!pim || typeof pim !== "object" || Array.isArray(pim)) return undefined;
		return pim as Record<string, unknown>;
	};
	// Project wins per scope. An invalid value is treated as ABSENT for its
	// scope (warn + fall through), not as "defer" — a project typo must not
	// override a valid global policy.
	const resolve = (raw: unknown): ChildPolicy | undefined => {
		if (raw === undefined) return undefined;
		if (raw === "defer" || raw === "settings") return raw;
		if (!(globalThis as any)[CHILD_POLICY_WARNED_KEY]) {
			(globalThis as any)[CHILD_POLICY_WARNED_KEY] = true;
			console.warn(
				`[pi-tool-masking] Invalid piToolMasking.childPolicy: ${JSON.stringify(
					raw,
				)} — must be "defer" or "settings"; treating as absent.`,
			);
		}
		return undefined;
	};
	return (
		resolve(read("project")?.["childPolicy"]) ??
		resolve(read("global")?.["childPolicy"]) ??
		"defer"
	);
}

/**
 * Resolve a toolset's effective fresh-session default: settings tier (2)
 * then packaged `spec.defaultEnabled` (3). **Ignores resolution mode** —
 * callers needing mode-aware behavior consult `readBranchModeState`
 * themselves. Pass `snapshot` (`readMergedToolsetDefaults()`) when calling
 * from a loop over multiple toolsets to avoid re-reading disk per toolset.
 */
export function getEffectiveDefault(
	spec: ToolsetSpec,
	snapshot?: ToolsetDefaultsMap,
): boolean {
	// Empty branch: no chat-branch tier — falls through to settings pin,
	// then `defaultEnabled ?? true`.
	return resolveExclusionTier(
		spec,
		[],
		snapshot ?? readMergedToolsetDefaults(),
	).enabled;
}

// ---------------------------------------------------------------------------
// Settings.json writer — toolsetDefaults tier
// ---------------------------------------------------------------------------

/**
 * Read one scope's settings.json, run `mutator` against the parsed object,
 * and write it back iff `mutator` returns `true` (the return value is
 * "did it write"). The malformed-file guard throws before `mutator` runs,
 * so a corrupt file is never handed to a mutator and never overwritten.
 *
 * ponytail: read-modify-write is not atomic — concurrent Pi sessions
 * writing the same global settings.json can lose writes. An advisory
 * file lock or write-to-temp+rename would close this; revisit if
 * cross-session write contention becomes observable.
 */
function mutateSettingsJson(
	scope: "global" | "project",
	mutator: (existing: Record<string, unknown>) => boolean,
): boolean {
	const path = settingsPath(scope);

	let existing: Record<string, unknown>;
	try {
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new MalformedSettingsError(
					`[pi-tool-masking] Refusing to overwrite non-object settings.json at ` +
						`${path}. The file contains ${
							Array.isArray(parsed)
								? "a JSON array"
								: typeof parsed === "object"
									? "null"
									: typeof parsed
						}. Fix or remove it before writing.`,
				);
			}
			existing = parsed as Record<string, unknown>;
		} else {
			existing = {};
		}
	} catch (err: unknown) {
		if (err instanceof MalformedSettingsError) throw err;
		if (err instanceof SyntaxError) {
			throw new MalformedSettingsError(
				`[pi-tool-masking] Refusing to overwrite malformed settings.json at ` +
					`${path}. Fix or remove it before writing. Parse error: ${err.message}`,
			);
		}
		throw err;
	}

	const write = mutator(existing);

	if (write) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
	}
	return write;
}

/**
 * Write a batch of `toolsetDefaults` entries to one settings scope
 * (`entries` in the shape `readMergedToolsetDefaults()` returns; shallow
 * per-entry merge — unrelated entries preserved). A no-change write leaves
 * the file untouched. Malformed-file guard: missing file → write fresh;
 * non-object or unparsable JSON → **throw** rather than overwrite user
 * config. Returns the destination file's path.
 */
export function writeToolsetDefaults(
	entries: ToolsetDefaultsMap,
	scope: "global" | "project",
): string {
	mutateSettingsJson(scope, (existing) => {
		// Non-object `toolsetDefaults` (array/string/null) recovers to `{}` —
		// same recovery as the reader (`parseToolsetDefaults`). A bare array
		// would swallow string-keyed writes (JSON.stringify drops them) and a
		// string would throw a confusing TypeError on `td[key] = ...`.
		const raw = existing.toolsetDefaults;
		const td: Record<string, unknown> =
			raw && typeof raw === "object" && !Array.isArray(raw)
				? (raw as Record<string, unknown>)
				: {};
		let changed = false;
		for (const [key, val] of Object.entries(entries)) {
			if (
				(td[key] as { enabled?: unknown } | undefined)?.enabled !== val.enabled
			) {
				td[key] = { enabled: val.enabled };
				changed = true;
			}
		}
		if (!changed) return false;
		existing.toolsetDefaults = td;
		return true;
	});
	return settingsPath(scope);
}

/**
 * Remove the `toolsetDefaults` wrapper key from one scope's settings file,
 * preserving every other top-level key (every toolset in that scope then
 * falls back to its packaged default). Returns the file's path, or `null`
 * if the key was already absent. Malformed-file guard: same as
 * {@link writeToolsetDefaults}.
 */
export function clearToolsetDefaults(
	scope: "global" | "project",
): string | null {
	return mutateSettingsJson(scope, (existing) => {
		if (!("toolsetDefaults" in existing)) return false; // no write, no reformat
		delete existing.toolsetDefaults;
		return true;
	})
		? settingsPath(scope)
		: null;
}

/**
 * Error thrown when refusing to overwrite a malformed or non-object
 * settings.json (data-loss guard). Catch with `instanceof` — safe here,
 * thrown and caught from the same module instance; deliberately unlike
 * {@link AllowlistModeError}'s name-based catch, which crosses copies via
 * the shared `globalThis` registry. Don't harmonize either side.
 */
export class MalformedSettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MalformedSettingsError";
	}
}

/**
 * Test-only internals, grouped so the un-exported status is structural: if
 * you reach for `__internal.` you are off the supported surface. The members
 * may change or vanish between any releases (majors included); downstream
 * test suites use them at their own risk.
 *
 * @internal
 */
export const __internal = {
	planBatch,
	executeBatchPlan,
	parseToolsetDefaults,
};
