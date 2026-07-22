import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
const HANDLER_GUARD_KEY = "__piToolMaskingRestoreHandlerRegistered";

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
// Ensure session_start / session_tree restore handler is registered once
// ---------------------------------------------------------------------------

function ensureRestoreHandler(pi: ExtensionAPI): void {
	if ((globalThis as any)[HANDLER_GUARD_KEY]) return;
	(globalThis as any)[HANDLER_GUARD_KEY] = true;

	// Restore handler — body filled in Sprint 3.
	// Registered now to ensure correct ordering (§6 capture-ordering note).
	pi.on("session_start", () => {
		// Sprint 3: restore state from branch entries
	});
	pi.on("session_tree", () => {
		// Sprint 3: restore state from branch entries
	});
}

// ---------------------------------------------------------------------------
// ToolsetImpl — concrete Toolset returned by defineToolset
// ---------------------------------------------------------------------------

class ToolsetImpl implements Toolset {
	constructor(private readonly spec: ToolsetSpec) {}

	enable(pi: ExtensionAPI): void {
		const current = new Set(pi.getActiveTools());
		const registeredNames = [...this.spec.names].filter((n) =>
			pi.getAllTools().some((t) => t.name === n),
		);

		// Already fully enabled — no-op
		if (registeredNames.every((n) => current.has(n))) return;

		const next = [...new Set([...current, ...registeredNames])];
		pi.setActiveTools(next);
		pi.appendEntry(this.spec.persistKey, { enabled: true });
		pi.events.emit(TOOLSET_EVENTS.changed, {
			id: this.spec.id,
			enabled: true,
		});
	}

	disable(pi: ExtensionAPI): void {
		const current = pi.getActiveTools();
		const filtered = current.filter((n) => !this.spec.names.has(n));

		// Already fully disabled — no-op
		if (filtered.length === current.length) return;

		pi.setActiveTools(filtered);
		pi.appendEntry(this.spec.persistKey, { enabled: false });
		pi.events.emit(TOOLSET_EVENTS.changed, {
			id: this.spec.id,
			enabled: false,
		});
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
			// Idempotent re-registration — return existing toolset
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
