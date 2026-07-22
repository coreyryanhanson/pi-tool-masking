import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// §5 Public API — types
// ---------------------------------------------------------------------------

export interface ToolsetSpec {
	/** Stable id, e.g. "portal.web". Used in persist keys and event payloads. */
	id: string;
	/** Human-readable name for the group. Optional — presenters fall back to id. */
	label?: string;
	/** One-line description of what enabling the group does. Optional — presenters omit when absent. */
	description?: string;
	/** Tool names this toolset governs. */
	names: Set<string>;
	/** Primary persistence key the toolset writes, e.g. "toolset-state:portal.web". */
	persistKey: string;
	/** Fresh-session fallback when no branch entry exists. */
	defaultEnabled?: boolean;
	/** Addressability: when true, members are reachable only via the group. Default false. */
	masked?: boolean;
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
	/** Toolset id (e.g. "portal.web"). Always set. */
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

interface RegistryEntry {
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
	const keysA = Reflect.ownKeys(a);
	const keysB = Reflect.ownKeys(b);
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
		const mode = getModuleState().defaultResolutionMode;
		const branch = ctx.sessionManager.getBranch();

		for (const [, entry] of registry) {
			const { spec } = entry;

			// Find persisted entry for this toolset (last-writer-wins)
			const persistEntries = branch.filter(
				(b: any) => b.customType === spec.persistKey && b.data != null,
			);

			if (persistEntries.length > 0) {
				const lastEntry = persistEntries[persistEntries.length - 1];
				const enabled = (lastEntry as any).data?.enabled;
				if (typeof enabled === "boolean") {
					_applyRestoreToolset(spec, pi, enabled, true);
				}
			} else {
				// No entry — resolve default based on mode (§4.5)
				const fallback = spec.defaultEnabled ?? true;
				const enabled = mode === "inclusion" ? false : fallback;
				_applyRestoreToolset(spec, pi, enabled, false);
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
		_disableDependents(registry, id, pi, [...path, id]);
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

	const toolset = new ToolsetImpl(spec);
	registry.set(spec.id, { spec, toolset });

	ensureRestoreHandler(pi);

	return toolset;
}

export function setDefaultResolutionMode(
	_pi: ExtensionAPI,
	mode: DefaultResolutionMode,
): void {
	getModuleState().defaultResolutionMode = mode;
}

export function getDefaultResolutionMode(
	_pi: ExtensionAPI,
): DefaultResolutionMode {
	return getModuleState().defaultResolutionMode;
}

export function readMergedSettings(): Record<string, unknown> {
	try {
		const globalPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		const projectPath = path.join(process.cwd(), ".pi", "settings.json");

		let merged: Record<string, unknown> = {};

		// Global settings
		try {
			const globalRaw = fs.readFileSync(globalPath, "utf-8");
			merged = { ...JSON.parse(globalRaw) };
		} catch {
			// File missing or malformed — skip
		}

		// Project settings (override global)
		try {
			const projectRaw = fs.readFileSync(projectPath, "utf-8");
			merged = { ...merged, ...JSON.parse(projectRaw) };
		} catch {
			// File missing or malformed — skip
		}

		return merged;
	} catch {
		return {};
	}
}
