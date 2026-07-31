import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// §5 Public API — types
// ---------------------------------------------------------------------------

export interface ToolsetSpec {
	/** Stable id, e.g. "my-plugin.web". Used in persist keys and event payloads. */
	id: string;
	/** Human-readable name for the group. Optional — presenters fall back to id. */
	label?: string;
	/** One-line description of what enabling the group does. Optional — presenters omit when absent. */
	description?: string;
	/** Tool names this toolset governs. */
	names: Set<string>;
	/** Primary persistence key the toolset writes, e.g. "toolset-state:my-plugin.web". */
	persistKey: string;
	/** Fresh-session fallback when no branch entry exists. */
	defaultEnabled?: boolean;
	/** Dependency: ids of toolsets that must be enabled for this one. */
	requires?: string[];
	/** When true, a group toggle additionally emits one `changed` event per member tool. Default false. */
	emitMemberEvents?: boolean;
}

export interface Toolset {
	enable(pi: ExtensionAPI): void;
	disable(pi: ExtensionAPI): void;
	isEnabled(pi: ExtensionAPI): boolean;
}

export interface ToolsetChangedEvent {
	/** Toolset id (e.g. "my-plugin.web"). Always set. */
	id: string;
	enabled: boolean;
	/** Present only when emitMemberEvents is on and this is a per-member fanout event. */
	member?: string;
}

export type DefaultResolutionMode = "exclusion" | "inclusion";

// ---------------------------------------------------------------------------
// §6 Change notification — event names
// ---------------------------------------------------------------------------

export const TOOLSET_EVENTS = {
	changed: "toolset:changed",
	restored: "toolset:restored",
} as const;

// ---------------------------------------------------------------------------
// Registry on globalThis (§6.1)
// ---------------------------------------------------------------------------

const REGISTRY_KEY = "__piToolMaskingRegistry";
const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";

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
// Shared in-memory state (library-level, not per-consumer)
// ---------------------------------------------------------------------------

const MODULE_KEY = "__piToolMaskingModuleState";
const MODE_PERSIST_KEY = "toolset-resolution-mode";

interface ModuleState {
	defaultResolutionMode: DefaultResolutionMode;
}

function getModuleState(): ModuleState {
	if (!(MODULE_KEY in globalThis)) {
		(globalThis as any)[MODULE_KEY] = {
			defaultResolutionMode: "exclusion" as DefaultResolutionMode,
		};
	}
	return (globalThis as any)[MODULE_KEY] as ModuleState;
}

// ---------------------------------------------------------------------------
// deepEqual for spec comparison (§6.1 idempotent re-registration)
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a instanceof Set && b instanceof Set) {
		if (a.size !== b.size) return false;
		for (const v of a) if (!b.has(v)) return false;
		return true;
	}
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	)
		return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const definedKeys = (o: object) =>
		Reflect.ownKeys(o).filter((k) => (o as any)[k] !== undefined);
	const keysA = definedKeys(a);
	const keysB = definedKeys(b);
	if (keysA.length !== keysB.length) return false;
	return keysA.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

// ---------------------------------------------------------------------------
// Ensure session_start / session_tree restore handler is registered
// (dedup at runtime by event-object identity, not at registration time)
// ---------------------------------------------------------------------------

function ensureRestoreHandler(pi: ExtensionAPI): void {
	// Dedup by event-object identity (§6). The runner passes the same event
	// reference to every extension's handler in one emit() call, so the first
	// handler wins and the rest skip. Each /reload constructs a fresh event
	// object, so restore re-runs with the fresh pi.
	const doRestore = (event: unknown, ctx: ExtensionContext): void => {
		if ((globalThis as any)[RESTORE_EVENT_KEY] === event) return;
		(globalThis as any)[RESTORE_EVENT_KEY] = event;

		const registry = getRegistry();

		// Re-read durable resolution mode before per-toolset fallback (§4.5).
		// setDefaultResolutionMode persists this bit; a fresh process defaults
		// to "exclusion" until the persisted entry is replayed here. Mode
		// entries are from a prior session (not written during this restore), so
		// a single read here is sufficient.
		const modeEntries = ctx.sessionManager
			.getBranch()
			.filter((b: any) => b.customType === MODE_PERSIST_KEY && b.data?.mode);
		if (modeEntries.length > 0) {
			getModuleState().defaultResolutionMode = (
				modeEntries[modeEntries.length - 1] as any
			).data.mode;
		}
		const mode = getModuleState().defaultResolutionMode;

		// ponytail: restore applies each toolset's entry independently and does
		// NOT re-run the requires cascade. Safe because §7.1 guarantees persisted
		// state is always consistent — the live-toggling cascade (§4.4) makes an
		// incoherent persisted combo unreachable. Re-adding cascade here would
		// double-toggle and break restore independence.
		//
		// Re-read the branch per toolset (not once before the loop): a companion
		// mirror (§10.1) fires synchronously inside `_applyRestoreToolset` and may
		// `appendEntry` for a toolset later in iteration order (e.g. my-plugin.web's
		// default-false restore makes search.web disable itself). Snapshotting the
		// branch once would hide that write from the later toolset, so it would
		// fall back to its packaged default and desync from the companion — the
		// §6 "search's own restore reads the branch and finds the entry the mirror
		// just wrote" guarantee.
		//
		// Read settings.json toolset defaults once per restore pass.
		// settings.json is stable mid-restore (unlike the branch, which
		// companion mirroring can mutate), so a single read suffices.
		const settingsDefaults = readMergedToolsetDefaults();
		for (const [, entry] of registry) {
			const { spec } = entry;

			// Find persisted entry for this toolset (last-writer-wins).
			// Fresh read per toolset so companion-mirror writes during this
			// pass are visible to later toolsets. The `b.data != null` filter
			// is dropped: a null (tombstoned) last entry means "cleared →
			// fall through to settings → mode floor → packaged" and must beat
			// a stale prior entry instead of being invisible.
			const branchNow = ctx.sessionManager.getBranch();
			const persistEntries = branchNow.filter(
				(b: any) => b.customType === spec.persistKey,
			);
			const lastEntry = persistEntries[persistEntries.length - 1];
			const enabled = (lastEntry as any)?.data?.enabled;
			if (typeof enabled === "boolean") {
				_applyRestoreToolset(spec, pi, enabled, true);
			} else {
				// No usable branch entry — fall through to settings tier (2),
				// then mode floor, then packaged `defaultEnabled` (3). A pinned
				// settings entry is explicit user intent and participates in
				// BOTH modes — mirroring how the chat-branch tier (also user
				// intent) is honored in inclusion via the if-branch. Only
				// unpinned toolsets consult mode for the floor (exclusion →
				// `defaultEnabled ?? true`, inclusion → false).
				// `readMergedToolsetDefaults()` returns the on-disk shape
				//   Record<persistKey, { enabled: boolean }>
				// so the pin is the wrapped object; unwrap with `?.enabled`.
				const settingsEnabled = settingsDefaults[spec.persistKey]?.enabled;
				const fallback = spec.defaultEnabled ?? true;
				const resolved =
					typeof settingsEnabled === "boolean"
						? settingsEnabled
						: mode === "inclusion"
							? false
							: fallback;
				_applyRestoreToolset(spec, pi, resolved, false);
			}
		}
	};

	pi.on("session_start", doRestore);
	pi.on("session_tree", doRestore);
}

// ---------------------------------------------------------------------------
// Event emission helper (group + optional member fanout)
// ---------------------------------------------------------------------------

function _emitToolsetEvents(
	spec: ToolsetSpec,
	pi: ExtensionAPI,
	eventType: string,
	enabled: boolean,
): void {
	pi.events.emit(eventType, { id: spec.id, enabled });

	if (spec.emitMemberEvents) {
		for (const name of spec.names) {
			// Only emit for names that are actually registered tools (§6)
			if (!pi.getAllTools().some((t) => t.name === name)) continue;
			pi.events.emit(eventType, {
				id: spec.id,
				enabled,
				member: name,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Helper: enable a single toolset (writes entry + emits if state changed)
// ---------------------------------------------------------------------------

function _applyEnable(spec: ToolsetSpec, pi: ExtensionAPI): void {
	const current = new Set(pi.getActiveTools());
	const registeredNames = [...spec.names].filter((n) =>
		pi.getAllTools().some((t) => t.name === n),
	);

	if (registeredNames.every((n) => current.has(n))) return;

	const next = [...new Set([...current, ...registeredNames])];
	pi.setActiveTools(next);
	pi.appendEntry(spec.persistKey, { enabled: true });
	_emitToolsetEvents(spec, pi, TOOLSET_EVENTS.changed, true);
}

// ---------------------------------------------------------------------------
// Helper: disable a single toolset (writes entry + emits if state changed)
// ---------------------------------------------------------------------------

function _applyDisable(spec: ToolsetSpec, pi: ExtensionAPI): void {
	const current = pi.getActiveTools();
	const filtered = current.filter((n) => !spec.names.has(n));

	if (filtered.length === current.length) return;

	pi.setActiveTools(filtered);
	pi.appendEntry(spec.persistKey, { enabled: false });
	_emitToolsetEvents(spec, pi, TOOLSET_EVENTS.changed, false);
}

// ---------------------------------------------------------------------------
// Restore-specific apply: applies state without persisting, always emits
// isPersistedEntry=true → restored event, false → changed event
// ---------------------------------------------------------------------------

function _applyRestoreToolset(
	spec: ToolsetSpec,
	pi: ExtensionAPI,
	enabled: boolean,
	isPersistedEntry: boolean,
): void {
	const registeredNames = [...spec.names].filter((n) =>
		pi.getAllTools().some((t) => t.name === n),
	);

	if (enabled) {
		const current = new Set(pi.getActiveTools());
		const next = [...new Set([...current, ...registeredNames])];
		pi.setActiveTools(next);
	} else {
		const current = pi.getActiveTools();
		// Use spec.names.has(n) (not registeredNames) to match _applyDisable —
		// an unregistered spec member active in the list must be removed on
		// restore just like a manual disable would.
		const filtered = current.filter((n) => !spec.names.has(n));
		pi.setActiveTools(filtered);
	}

	// Always emit regardless of state (always-emit invariant, §6)
	const eventType = isPersistedEntry
		? TOOLSET_EVENTS.restored
		: TOOLSET_EVENTS.changed;
	_emitToolsetEvents(spec, pi, eventType, enabled);
}

// ---------------------------------------------------------------------------
// Enable cascade + cycle detection (§4.4, §9)
// ---------------------------------------------------------------------------

function _enableToolset(
	registry: Registry,
	spec: ToolsetSpec,
	pi: ExtensionAPI,
	path: string[],
): void {
	if (path.includes(spec.id)) {
		throw new Error(
			`[pi-tool-masking] Cycle detected: ${[...path, spec.id].join(" \u2192 ")}`,
		);
	}

	path.push(spec.id);

	// Always cascade to dependencies first
	if (spec.requires) {
		for (const depId of spec.requires) {
			const dep = registry.get(depId);
			if (!dep) continue; // forward reference — not yet registered
			_enableToolset(registry, dep.spec, pi, path);
		}
	}

	// Then enable self (no-op if already fully enabled)
	_applyEnable(spec, pi);

	path.pop();
}

// ---------------------------------------------------------------------------
// Disable reverse-cascade (§4.4, §9)
// ---------------------------------------------------------------------------

function _disableDependents(
	registry: Registry,
	disabledId: string,
	pi: ExtensionAPI,
	path: string[],
): void {
	for (const [id, entry] of registry) {
		if (!entry.spec.requires?.includes(disabledId)) continue;

		if (path.includes(id)) {
			throw new Error(
				`[pi-tool-masking] Cycle detected on disable: ${[...path, id].join(" \u2192 ")}`,
			);
		}

		// Disable this dependent
		_applyDisable(entry.spec, pi);

		// Recurse to its dependents
		path.push(id);
		_disableDependents(registry, id, pi, path);
		path.pop();
	}
}

// ---------------------------------------------------------------------------
// ToolsetImpl — concrete Toolset returned by defineToolset
// ---------------------------------------------------------------------------

class ToolsetImpl implements Toolset {
	constructor(private readonly spec: ToolsetSpec) {}

	enable(pi: ExtensionAPI): void {
		const registry = getRegistry();
		const path: string[] = [];
		_enableToolset(registry, this.spec, pi, path);
	}

	disable(pi: ExtensionAPI): void {
		const registry = getRegistry();
		const path: string[] = [this.spec.id];

		// Disable self
		_applyDisable(this.spec, pi);

		// Cascade to dependents (toolsets whose requires contains this one's id)
		_disableDependents(registry, this.spec.id, pi, path);
	}

	isEnabled(pi: ExtensionAPI): boolean {
		const active = new Set(pi.getActiveTools());
		return [...this.spec.names].some((n) => active.has(n));
	}
}

// ---------------------------------------------------------------------------
// §5 Public API — functions
// ---------------------------------------------------------------------------

export function defineToolset(pi: ExtensionAPI, spec: ToolsetSpec): Toolset {
	if (!spec.id || spec.id.trim() === "") {
		throw new Error("[pi-tool-masking] spec.id must be a non-empty string");
	}
	if (!spec.persistKey || spec.persistKey.trim() === "") {
		throw new Error(
			"[pi-tool-masking] spec.persistKey must be a non-empty string",
		);
	}

	const registry = getRegistry();
	const existing = registry.get(spec.id);

	if (existing) {
		if (deepEqual(existing.spec, spec)) {
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
			throw new Error(
				`[pi-tool-masking] persistKey collision: "${spec.persistKey}" is already used by toolset "${id}"`,
			);
		}
	}

	// Name-overlap guard: no two toolsets may claim the same tool name. Every
	// downstream failure mode (isEnabled lying, restore order-dependence, enable
	// no-op, skipped dependents, focus leaks, mis-attribution, double-counts)
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

export function setDefaultResolutionMode(
	pi: ExtensionAPI,
	mode: DefaultResolutionMode,
): void {
	if (mode !== "exclusion" && mode !== "inclusion") {
		throw new Error(
			`[pi-tool-masking] Invalid defaultResolutionMode: "${mode}". Must be "exclusion" or "inclusion".`,
		);
	}
	getModuleState().defaultResolutionMode = mode;
	pi.appendEntry(MODE_PERSIST_KEY, { mode });
}

export function getDefaultResolutionMode(): DefaultResolutionMode {
	return getModuleState().defaultResolutionMode;
}

/**
 * Enumerate every registered toolset in the global registry.
 * Returns a read-only snapshot — callers cannot mutate the live registry
 * through the returned array. Each entry carries the full spec and the
 * Toolset handle (enable / disable / isEnabled).
 *
 * No `pi` argument needed — enumeration is a pure registry read.
 */
export function getRegisteredToolsets(): readonly RegistryEntry[] {
	return [...getRegistry().values()];
}

// ---------------------------------------------------------------------------
// Settings.json reader — toolsetDefaults tier
// ---------------------------------------------------------------------------

/** On-disk settings shape: `toolsetDefaults[persistKey] = { enabled }`. */
type ToolsetDefaultsMap = Record<string, { enabled: boolean }>;

function settingsPath(scope: "global" | "project"): string {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return scope === "global"
		? join(agentDir, "settings.json")
		: join(process.cwd(), ".pi", "settings.json");
}

/**
 * Read one scope's settings.json as a parsed object, or `{}` on any
 * read/parse failure (never-throw policy — a malformed file contributes
 * `{}` to the merge; only mutators throw `MalformedSettingsError`).
 */
function readSettingsJsonSafe(scope: "global" | "project"): unknown {
	const path = settingsPath(scope);
	try {
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

let _settingsOverride: ToolsetDefaultsMap | null = null;

/**
 * Inject a snapshot of toolset defaults for tests. Pass `null` to restore
 * the disk-read path. Production code never calls this.
 *
 * @internal
 */
export function setSettingsOverrideForTests(
	defaults: ToolsetDefaultsMap | null,
): void {
	_settingsOverride = defaults;
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
export function parseToolsetDefaults(json: unknown): ToolsetDefaultsMap {
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
 * Shallow-merge global and project toolset defaults.
 *
 * Project wins on key collision: `{ ...global_, ...project }`. Per-entry
 * only — no deep merge of the `{ enabled }` values.
 *
 * @internal
 */
export function mergeToolsetDefaults(
	global_: ToolsetDefaultsMap,
	project: ToolsetDefaultsMap,
): ToolsetDefaultsMap {
	return { ...global_, ...project };
}

/**
 * Read and merge toolset defaults from settings.json (global + project).
 *
 * Reads `json.toolsetDefaults` from:
 *   `<agentDir>/settings.json`  (global)
 *   `<cwd>/.pi/settings.json`   (project)
 *
 * Where `agentDir = PI_CODING_AGENT_DIR ?? ~/.pi/agent`.
 * Missing/unreadable/malformed files contribute `{}`. Never throws.
 *
 * Returns the on-disk shape `Record<persistKey, { enabled: boolean }>`
 * (not flattened) — call sites unwrap with `?.enabled`. Project overrides
 * global per entry.
 *
 * When `setSettingsOverrideForTests` has set an override, returns that
 * override verbatim instead of reading disk.
 *
 * @public — exported for pi-tbox's snapshot-in usage (read once per loop
 * and pass to `getEffectiveDefault`).
 *
 * ponytail: hardcodes the two pi-core settings paths (global
 * `~/.pi/agent/settings.json`, project `<cwd>/.pi/settings.json`) with no
 * configuration knob — if pi-core moves its settings paths or format this
 * breaks. Upgrade path: a pi-core settings-path registry, if one ever appears.
 */
export function readMergedToolsetDefaults(): ToolsetDefaultsMap {
	if (_settingsOverride !== null) return { ..._settingsOverride };
	return mergeToolsetDefaults(
		parseToolsetDefaults(readSettingsJsonSafe("global")),
		parseToolsetDefaults(readSettingsJsonSafe("project")),
	);
}

/**
 * Read toolset defaults from one settings.json scope (global or project).
 *
 * Returns the raw `toolsetDefaults` block parsed from that scope's file,
 * without merging. Missing/unreadable/malformed files return `{}`.
 *
 * When `setSettingsOverrideForTests` has set an override, returns that
 * override for both scopes (test mode approximation — attribution tests
 * must use the writer seam + disk round-trip).
 *
 * @public — exported for pi-tbox's /tbox defaults show command, which
 * needs per-scope attribution.
 */
export function readToolsetDefaults(
	scope: "global" | "project",
): ToolsetDefaultsMap {
	if (_settingsOverride !== null) return { ..._settingsOverride };
	return parseToolsetDefaults(readSettingsJsonSafe(scope));
}

/**
 * Resolve a toolset's effective fresh-session default: settings tier (2)
 * then packaged `spec.defaultEnabled` (3). **Ignores resolution mode** —
 * callers that need mode-aware behavior must consult
 * `getDefaultResolutionMode()` themselves and act accordingly.
 *
 * Pass an explicit `snapshot` (the merged settings map from
 * `readMergedToolsetDefaults()`) when calling from a loop over multiple
 * toolsets — read the snapshot once before the loop and pass it in to
 * avoid re-reading disk per toolset. When `snapshot` is omitted the
 * function performs its own one-off `readMergedToolsetDefaults()` call.
 *
 * `snapshot` shares the on-disk shape
 * `Record<persistKey, { enabled: boolean }>`; the pin is unwrapped via
 * `?.enabled`. A missing or malformed entry falls through to
 * `spec.defaultEnabled ?? true`.
 *
 * @public — exported for pi-tbox's focusOff / actuateNewToolsets call
 * sites, which need the settings-aware default without re-implementing
 * the reader.
 */
export function getEffectiveDefault(
	spec: ToolsetSpec,
	snapshot?: ToolsetDefaultsMap,
): boolean {
	const map = snapshot ?? readMergedToolsetDefaults();
	const settingsEnabled = map[spec.persistKey]?.enabled;
	return typeof settingsEnabled === "boolean"
		? settingsEnabled
		: (spec.defaultEnabled ?? true);
}

// ---------------------------------------------------------------------------
// Settings.json writer — toolsetDefaults tier
// ---------------------------------------------------------------------------

let _settingsWriterOverride: {
	global: ToolsetDefaultsMap;
	project: ToolsetDefaultsMap;
} | null = null;

/**
 * Capture toolset-defaults writes in-memory instead of hitting disk. Pass
 * `null` to restore the disk-write path. Independent of
 * `setSettingsOverrideForTests` — both seams must be cleared (`null`) for a
 * true round-trip that hits disk on both read and write.
 *
 * @internal
 */
export function setSettingsWriterOverrideForTests(
	state: {
		global: ToolsetDefaultsMap;
		project: ToolsetDefaultsMap;
	} | null,
): void {
	_settingsWriterOverride = state;
}

/**
 * Read one scope's settings.json (with the malformed-file guard), run
 * `mutator` against the parsed object, and write it back iff `mutator`
 * returns `true`. Returns the same boolean so callers whose result *is*
 * "did it write" (e.g. `clearToolsetDefaults`) can use it directly.
 *
 * `mutator` returns `false` to skip the write (used by clear when the
 * key is absent — no needless reformat of a hand-edited file). The
 * malformed-file guard throws before `mutator` runs, so a corrupt file is
 * never handed to a mutator and never overwritten.
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
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
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
 * Write a batch of toolset default entries to one settings scope.
 *
 * `entries` is the on-disk shape `{ [persistKey]: { enabled: boolean } }`
 * — the same shape `readMergedToolsetDefaults()` returns. Each entry
 * becomes `toolsetDefaults[persistKey] = { enabled }` in the chosen
 * scope's settings file, preserving every other top-level key.
 *
 * Merge semantics: shallow per-entry within `toolsetDefaults`. Existing
 * entries for persistKeys NOT in `entries` are preserved; entries in
 * `entries` overwrite any same-key existing entry. A write where every
 * entry already matches its on-disk value is a no-op: the file is left
 * untouched (no reformat, no mtime bump).
 *
 * **Malformed-file guard:**
 *   - File missing → write fresh (nothing to lose).
 *   - File parses to a non-object (array, string, null) → **throw**
 *     (data-loss guard — would destroy unparsable user config).
 *   - `JSON.parse` throws → **throw** (same reason).
 *
 * @public
 */
export function writeToolsetDefaults(
	entries: ToolsetDefaultsMap,
	scope: "global" | "project",
): void {
	// Seam path: merge into memory
	if (_settingsWriterOverride !== null) {
		for (const [key, val] of Object.entries(entries)) {
			_settingsWriterOverride[scope][key] = { enabled: val.enabled };
		}
		return;
	}

	mutateSettingsJson(scope, (existing) => {
		const td: Record<string, unknown> =
			(existing.toolsetDefaults as Record<string, unknown> | undefined) ?? {};
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
}

/**
 * Remove the `toolsetDefaults` wrapper key entirely from one scope's
 * settings file, preserving every other top-level key. After this, every
 * toolset in that scope falls back to tier 3 (packaged default, or
 * `spec.defaultEnabled ?? true`).
 *
 * Returns `true` if the key existed and was removed, `false` if it was
 * already absent (or the file was missing). No per-entry clear path by
 * design — callers who want that write an `entries` map without the
 * unwanted keys via `writeToolsetDefaults`.
 *
 * **Malformed-file guard:** same as `writeToolsetDefaults` — throws on
 * non-object or unparsable JSON rather than overwriting user config.
 *
 * @public
 */
export function clearToolsetDefaults(scope: "global" | "project"): boolean {
	// Seam path: clear all keys in memory
	if (_settingsWriterOverride !== null) {
		const state = _settingsWriterOverride[scope];
		const keys = Object.keys(state);
		for (const key of keys) {
			delete state[key];
		}
		return keys.length > 0;
	}

	return mutateSettingsJson(scope, (existing) => {
		if (!("toolsetDefaults" in existing)) return false; // no write, no reformat
		delete existing.toolsetDefaults;
		return true;
	});
}

/**
 * Error thrown when refusing to overwrite a malformed or non-object
 * settings.json to prevent data-loss of user pi-core config.
 *
 * @public — exported for downstream consumers to distinguish malformed-file
 * errors from generic I/O errors without string-matching `message`.
 * Catch with `instanceof MalformedSettingsError`.
 */
export class MalformedSettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MalformedSettingsError";
	}
}
