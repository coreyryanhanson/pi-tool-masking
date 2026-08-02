import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi } from "vitest";
import { MockPI } from "./mock-pi.js";
import {
	defineToolset,
	TOOLSET_EVENTS,
	setDefaultResolutionMode,
	getDefaultResolutionMode,
	getActiveAllowlist,
	getRegisteredToolsets,
	parseToolsetDefaults,
	mergeToolsetDefaults,
	readMergedToolsetDefaults,
	readToolsetDefaults,
	getEffectiveDefault,
	setSettingsOverrideForTests,
	setSettingsWriterOverrideForTests,
	writeToolsetDefaults,
	clearToolsetDefaults,
	MalformedSettingsError,
	clearToolsetEntry,
	clearAllToolsetEntries,
	applyToolsetEnabled,
	type RegistryEntry,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createEnv(): { mock: MockPI; pi: ExtensionAPI } {
	const mock = new MockPI();
	return { mock, pi: mock as unknown as ExtensionAPI };
}

const REGISTRY_KEY = "__piToolMaskingRegistry";
const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";
const MODULE_STATE_KEY = "__piToolMaskingModuleState";
const DEPRECATION_WARNED_KEY = "__piToolMaskingDeprecationWarned";

function cleanRegistry(): void {
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[RESTORE_EVENT_KEY];
	delete (globalThis as any)[MODULE_STATE_KEY];
	delete (globalThis as any)[DEPRECATION_WARNED_KEY];
}

function makeSpec(
	overrides: Partial<{
		id: string;
		persistKey: string;
		names: Set<string>;
		defaultEnabled: boolean;
		requires: string[];
		emitMemberEvents: boolean;
		label: string;
		description: string;
	}> = {},
) {
	return {
		id: "test.toolset",
		names: new Set(["tool-a", "tool-b"]),
		persistKey: "toolset-state:test.toolset",
		...overrides,
	};
}

beforeEach(() => {
	cleanRegistry();
	setSettingsOverrideForTests({});
});

afterEach(() => {
	setSettingsOverrideForTests(null);
	setSettingsWriterOverrideForTests(null);
});

// ===================================================================
// Registry
// ===================================================================

describe("Registry", () => {
	it("initializes __piToolMaskingRegistry as a Map on globalThis", () => {
		const { pi } = createEnv();
		defineToolset(pi, makeSpec());
		const registry = (globalThis as any)[REGISTRY_KEY];
		expect(registry).toBeInstanceOf(Map);
	});

	it("registry is idempotent — same Map survives second defineToolset", () => {
		const { pi } = createEnv();
		defineToolset(pi, makeSpec({ id: "a.a", persistKey: "k:a.a" }));
		const regA = (globalThis as any)[REGISTRY_KEY];
		defineToolset(
			pi,
			makeSpec({
				id: "b.b",
				persistKey: "k:b.b",
				names: new Set(["tool-c", "tool-d"]),
			}),
		);
		const regB = (globalThis as any)[REGISTRY_KEY];
		expect(regB).toBe(regA);
		expect(regB.size).toBe(2);
	});
});

// ===================================================================
// defineToolset — validation
// ===================================================================

describe("defineToolset — validation", () => {
	it("throws on empty id", () => {
		const { pi } = createEnv();
		expect(() => defineToolset(pi, makeSpec({ id: "" }))).toThrow(
			"spec.id must be a non-empty string",
		);
	});

	it("throws on whitespace-only id", () => {
		const { pi } = createEnv();
		expect(() => defineToolset(pi, makeSpec({ id: "  " }))).toThrow(
			"spec.id must be a non-empty string",
		);
	});

	it("throws on empty persistKey", () => {
		const { pi } = createEnv();
		expect(() => defineToolset(pi, makeSpec({ persistKey: "" }))).toThrow(
			"spec.persistKey must be a non-empty string",
		);
	});

	it("throws on whitespace-only persistKey", () => {
		const { pi } = createEnv();
		expect(() => defineToolset(pi, makeSpec({ persistKey: "  " }))).toThrow(
			"spec.persistKey must be a non-empty string",
		);
	});

	it("valid spec does not throw", () => {
		const { pi } = createEnv();
		expect(() => defineToolset(pi, makeSpec())).not.toThrow();
	});
});

// ===================================================================
// defineToolset — restore handler registration
// ===================================================================

describe("defineToolset — restore handler registration", () => {
	it("registers session_start handler", () => {
		const { mock, pi } = createEnv();
		defineToolset(pi, makeSpec());
		expect(mock.hasHandler("session_start")).toBe(true);
	});

	it("registers session_tree handler", () => {
		const { mock, pi } = createEnv();
		defineToolset(pi, makeSpec());
		expect(mock.hasHandler("session_tree")).toBe(true);
	});

	it("dedup by event identity — N handlers, one run per event", () => {
		const { mock, pi } = createEnv();
		defineToolset(pi, makeSpec({ id: "a.a", persistKey: "k:a.a" }));
		defineToolset(
			pi,
			makeSpec({
				id: "b.b",
				persistKey: "k:b.b",
				names: new Set(["tool-c", "tool-d"]),
			}),
		);
		// No registration guard: each defineToolset registers its own handler
		expect(mock.handlerCount("session_start")).toBe(2);
		expect(mock.handlerCount("session_tree")).toBe(2);
		// Runtime dedup: fire once, each toolset emits exactly one event
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		const changedOrRestored = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed || c === TOOLSET_EVENTS.restored,
		);
		expect(changedOrRestored.length).toBe(2);
		emitSpy.mockRestore();
	});

	it("restore is /reload-safe — stale boolean no longer blocks fresh extension", () => {
		const { mock: mock1, pi: pi1 } = createEnv();
		mock1.registerTool({ name: "tool-a", description: "" });
		const spec = makeSpec({ names: new Set(["tool-a"]) });
		defineToolset(pi1, spec);

		// Simulate /reload: new MockPI, same globalThis, no cleanRegistry between
		const { mock: mock2, pi: pi2 } = createEnv();
		mock2.registerTool({ name: "tool-a", description: "" });

		// Pre-populate mock2's branch with persisted disabled state (simulates
		// the entry surviving in the real session branch across /reload)
		mock2.appendEntry("toolset-state:test.toolset", { enabled: false });

		// Re-register on pi2 (as pi would on /reload)
		defineToolset(pi2, spec);

		// Assert handler was registered on pi2 despite prior registration on pi1
		expect(mock2.hasHandler("session_start")).toBe(true);

		const emitSpy = vi.spyOn(mock2.events, "emit");
		mock2.fireLifecycleEvent("session_start");

		// Restore ran on pi2: tools disabled, restored event on pi2's bus
		expect(mock2.getActiveTools()).not.toContain("tool-a");
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(restoredCalls.length).toBeGreaterThanOrEqual(1);

		// Second fire with a fresh event object → restore runs again
		mock2.fireLifecycleEvent("session_start");
		const restoredCallsAfterSecond = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(restoredCallsAfterSecond.length).toBeGreaterThanOrEqual(2);
		emitSpy.mockRestore();
	});

	// Companion mirror during restore must stay consistent.
	// A companion listening on `changed` for a base toolset fires synchronously
	// inside the base's restore and `appendEntry`s for itself. The restore loop
	// must re-read the branch per toolset so the companion's own restore sees
	// that freshly-written entry instead of falling back to its packaged default.
	it("companion mirror write during restore is visible to the companion's own restore", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "base-tool", description: "" });
		mock.registerTool({ name: "comp-tool", description: "" });

		// Base defaults OFF, companion defaults ON — the mismatch that exposed the bug.
		const baseSpec = makeSpec({
			id: "base",
			persistKey: "k:base",
			names: new Set(["base-tool"]),
			defaultEnabled: false,
		});
		const compSpec = makeSpec({
			id: "comp",
			persistKey: "k:comp",
			names: new Set(["comp-tool"]),
			defaultEnabled: true,
		});
		defineToolset(pi, baseSpec);
		const comp = defineToolset(pi, compSpec);

		// Companion co-activation: mirror base `changed` only.
		pi.events.on(TOOLSET_EVENTS.changed, (data: any) => {
			if (data.id === "base") {
				if (data.enabled) comp.enable(pi);
				else comp.disable(pi);
			}
		});

		// Real pi activates every extension tool at startup, THEN restore runs.
		// Seed the same initial state so the mirror's disable actually has a
		// tool to remove (and thus persists).
		mock.setActiveTools(["base-tool", "comp-tool"]);

		// Fresh session, no persisted entries. Restore: base falls back off →
		// emits changed → mirror disables comp (writes k:comp {enabled:false}).
		// comp's own restore must then find that entry and honor false, NOT
		// fall back to its packaged default true.
		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).not.toContain("base-tool");
		expect(mock.getActiveTools()).not.toContain("comp-tool");
		const compEntries = mock
			.getEntries("k:comp")
			.map((e) => (e.data as any)?.enabled);
		expect(compEntries).toContain(false);
	});

	it("companion co-activation round-trips across a resume boundary", () => {
		// Session 1: base off by default. User toggles base on → mirror enables
		// comp. Both persist {enabled:true}.
		const s1 = new MockPI();
		s1.registerTool({ name: "base-tool", description: "" });
		s1.registerTool({ name: "comp-tool", description: "" });
		const pi1 = s1 as unknown as ExtensionAPI;
		const base = defineToolset(pi1, {
			id: "base",
			persistKey: "k:base",
			names: new Set(["base-tool"]),
			defaultEnabled: false,
		});
		const comp = defineToolset(pi1, {
			id: "comp",
			persistKey: "k:comp",
			names: new Set(["comp-tool"]),
			defaultEnabled: true,
		});
		pi1.events.on(TOOLSET_EVENTS.changed, (data: any) => {
			if (data.id === "base") {
				if (data.enabled) comp.enable(pi1);
				else comp.disable(pi1);
			}
		});
		// Real pi activates every extension tool at startup before restore.
		s1.setActiveTools(["base-tool", "comp-tool"]);
		s1.fireLifecycleEvent("session_start"); // base off → mirror disables comp
		base.enable(pi1); // base on → mirror enables comp

		expect(s1.getActiveTools()).toContain("base-tool");
		expect(s1.getActiveTools()).toContain("comp-tool");

		// Session 2: resume — new MockPI, branch seeded with session-1 entries.
		const persisted = s1
			.getEntries()
			.filter(
				(e) =>
					e.customType === "k:base" ||
					e.customType === "k:comp" ||
					e.customType === "toolset-resolution-mode",
			);
		const s2 = new MockPI();
		s2.registerTool({ name: "base-tool", description: "" });
		s2.registerTool({ name: "comp-tool", description: "" });
		for (const e of persisted) s2.appendEntry(e.customType, e.data);
		const pi2 = s2 as unknown as ExtensionAPI;
		defineToolset(pi2, {
			id: "base",
			persistKey: "k:base",
			names: new Set(["base-tool"]),
			defaultEnabled: false,
		});
		defineToolset(pi2, {
			id: "comp",
			persistKey: "k:comp",
			names: new Set(["comp-tool"]),
			defaultEnabled: true,
		});

		s2.fireLifecycleEvent("session_start");

		// Both must restore ON — comp's own {enabled:true} entry wins over its
		// packaged default and is not clobbered by a stale mirror-written false.
		expect(s2.getActiveTools()).toContain("base-tool");
		expect(s2.getActiveTools()).toContain("comp-tool");
	});
});

// ===================================================================
// defineToolset — collision policy
// ===================================================================

describe("defineToolset — collision policy", () => {
	it("warns and replaces on duplicate id with different spec", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi } = createEnv();
		const t1 = defineToolset(pi, makeSpec({ id: "dup", persistKey: "k:dup" }));
		const t2 = defineToolset(
			pi,
			makeSpec({ id: "dup", persistKey: "k:dup", defaultEnabled: false }),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('Toolset "dup" re-registered'),
		);
		// Registry holds the new spec, not the old
		const registered = getRegisteredToolsets();
		expect(registered).toHaveLength(1);
		expect(registered[0]!.spec.defaultEnabled).toBe(false);
		expect(t2).not.toBe(t1);
		warnSpy.mockRestore();
	});

	it("throws on duplicate persistKey across different ids", () => {
		const { pi } = createEnv();
		defineToolset(pi, makeSpec({ id: "a", persistKey: "shared-key" }));
		expect(() =>
			defineToolset(pi, makeSpec({ id: "b", persistKey: "shared-key" })),
		).toThrow("persistKey collision");
	});

	it("allows duplicate id with deepEqual-identical spec (idempotent re-registration)", () => {
		const { pi } = createEnv();
		const spec = makeSpec();
		const t1 = defineToolset(pi, spec);
		const t2 = defineToolset(pi, spec);
		expect(t2).toBe(t1);
	});

	it("idempotent re-registration with new object but same values (simulates jiti reload)", () => {
		const { pi } = createEnv();
		const spec1 = makeSpec({
			id: "my-plugin.web",
			persistKey: "toolset-state:my-plugin.web",
			names: new Set(["browser-navigate", "browser-click"]),
			defaultEnabled: true,
			requires: [],
		});
		const t1 = defineToolset(pi, spec1);
		const spec2 = makeSpec({
			id: "my-plugin.web",
			persistKey: "toolset-state:my-plugin.web",
			names: new Set(["browser-navigate", "browser-click"]),
			defaultEnabled: true,
			requires: [],
		});
		const t2 = defineToolset(pi, spec2);
		expect(t2).toBe(t1);
	});
});

// ===================================================================
// Name-overlap guard
// ===================================================================

describe("defineToolset — name-overlap guard", () => {
	it("rejects overlap: two toolsets claiming the same tool name throw", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({
			name: "x",
			description: "",
			sourceInfo: {
				path: "/home/u/.pi/.../my-plugin/index.ts",
				source: "my-plugin",
				scope: "user",
				origin: "top-level",
			},
		});
		defineToolset(
			pi,
			makeSpec({
				id: "my-plugin.web",
				persistKey: "toolset-state:my-plugin.web",
				names: new Set(["x"]),
			}),
		);
		let err: Error | undefined;
		try {
			defineToolset(
				pi,
				makeSpec({
					id: "acme.search",
					persistKey: "toolset-state:acme.search",
					names: new Set(["x"]),
				}),
			);
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeInstanceOf(Error);
		const msg = err!.message;
		expect(msg).toMatch(/name overlap/);
		expect(msg).toMatch(/my-plugin\.web/);
		expect(msg).toMatch(/acme\.search/);
		expect(msg).toMatch(/my-plugin\/index\.ts/);
		expect(msg).toMatch(/source: my-plugin/);
		// The second registration must not have entered the registry.
		expect(getRegisteredToolsets().map((e) => e.spec.id)).toEqual([
			"my-plugin.web",
		]);
	});

	it("gathers multiple collisions in one registration into one error", () => {
		const { pi } = createEnv();
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "toolset-state:a",
				names: new Set(["x"]),
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "b",
				persistKey: "toolset-state:b",
				names: new Set(["y"]),
			}),
		);
		let msg = "";
		try {
			defineToolset(
				pi,
				makeSpec({
					id: "c",
					persistKey: "toolset-state:c",
					names: new Set(["x", "y"]),
				}),
			);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toMatch(/tool "x" already claimed by toolset "a"/);
		expect(msg).toMatch(/tool "y" already claimed by toolset "b"/);
	});

	it("error omits tool-source line for an unregistered (forward-referenced) name", () => {
		const { pi } = createEnv();
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "toolset-state:a",
				names: new Set(["x"]),
			}),
		);
		// `x` is never registerTool'd, so no sourceInfo is available.
		let msg = "";
		try {
			defineToolset(
				pi,
				makeSpec({
					id: "b",
					persistKey: "toolset-state:b",
					names: new Set(["x"]),
				}),
			);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toMatch(/tool "x" already claimed by toolset "a"$/m);
		expect(msg).not.toMatch(/registered from/);
	});

	it("idempotent re-registration unaffected: unchanged spec does not throw", () => {
		const { pi } = createEnv();
		const spec = makeSpec({
			id: "my-plugin.web",
			persistKey: "toolset-state:my-plugin.web",
			names: new Set(["browser-navigate"]),
		});
		const t1 = defineToolset(pi, spec);
		const t2 = defineToolset(pi, spec);
		expect(t2).toBe(t1);
	});

	it("replace on changed spec re-runs the guard (self-skip works)", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi } = createEnv();
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "toolset-state:a",
				names: new Set(["x"]),
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "b",
				persistKey: "toolset-state:b",
				names: new Set(["y"]),
			}),
		);
		// Re-define "a" with a changed spec that now also claims `y` (owned by b).
		expect(() =>
			defineToolset(
				pi,
				makeSpec({
					id: "a",
					persistKey: "toolset-state:a",
					names: new Set(["x", "y"]),
				}),
			),
		).toThrow(/tool "y" already claimed by toolset "b"/);
		warnSpy.mockRestore();
	});

	it("forward-reference overlap caught: name not yet a registered tool still collides", () => {
		const { pi } = createEnv();
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "toolset-state:a",
				names: new Set(["x"]),
			}),
		);
		// `x` is not registerTool'd by either side — purely name-based collision.
		expect(() =>
			defineToolset(
				pi,
				makeSpec({
					id: "b",
					persistKey: "toolset-state:b",
					names: new Set(["x"]),
				}),
			),
		).toThrow(/name overlap/);
	});
});

// ===================================================================
// Toolset.enable
// ===================================================================

describe("Toolset.enable", () => {
	it("activates toolset names and appends entry", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		const ts = defineToolset(pi, makeSpec());
		ts.enable(pi);
		expect(mock.getActiveTools()).toEqual(
			expect.arrayContaining(["tool-a", "tool-b"]),
		);
		const entries = mock.getEntries("toolset-state:test.toolset");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.data).toEqual({ enabled: true });
	});

	it("is additive — keeps existing active tools", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		mock.registerTool({ name: "tool-c", description: "" });
		mock.setActiveTools(["tool-c"]);
		const ts = defineToolset(pi, makeSpec());
		ts.enable(pi);
		const active = mock.getActiveTools();
		expect(active).toContain("tool-a");
		expect(active).toContain("tool-b");
		expect(active).toContain("tool-c");
	});

	it("tolerates unregistered names (filters to only registered tools)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a", "does-not-exist"]) }),
		);
		ts.enable(pi);
		expect(mock.getActiveTools()).toContain("tool-a");
		expect(mock.getActiveTools()).not.toContain("does-not-exist");
	});

	it("is idempotent — second call is no-op (no double entry/emit)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		const ts = defineToolset(pi, makeSpec());
		ts.enable(pi);
		const entryCount = mock.getEntries().length;
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.enable(pi);
		expect(mock.getEntries().length).toBe(entryCount);
		expect(emitSpy).not.toHaveBeenCalled();
		emitSpy.mockRestore();
	});

	it("emits changed event with enabled: true", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		const emitSpy = vi.spyOn(mock.events, "emit");
		const ts = defineToolset(pi, makeSpec());
		ts.enable(pi);
		expect(emitSpy).toHaveBeenCalledWith(TOOLSET_EVENTS.changed, {
			id: "test.toolset",
			enabled: true,
		});
		emitSpy.mockRestore();
	});
});

// ===================================================================
// Toolset.disable
// ===================================================================

describe("Toolset.disable", () => {
	it("removes toolset names from active set and appends entry", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		const ts = defineToolset(pi, makeSpec());
		ts.enable(pi);
		ts.disable(pi);
		expect(mock.getActiveTools()).not.toContain("tool-a");
		expect(mock.getActiveTools()).not.toContain("tool-b");
		const disableEntries = mock.getEntries("toolset-state:test.toolset");
		const last = disableEntries[disableEntries.length - 1];
		expect(last?.data).toEqual({ enabled: false });
	});

	it("uses getActiveTools(), not getAllTools() — does not revive peer's tools", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-only", description: "" });
		mock.registerTool({ name: "b-only", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["a-only"]) }),
		);
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "b", persistKey: "k:b", names: new Set(["b-only"]) }),
		);
		tsA.enable(pi);
		tsB.enable(pi);
		expect(mock.getActiveTools()).toEqual(
			expect.arrayContaining(["a-only", "b-only"]),
		);
		tsA.disable(pi);
		expect(mock.getActiveTools()).not.toContain("a-only");
		expect(mock.getActiveTools()).toContain("b-only");
		tsB.disable(pi);
		expect(mock.getActiveTools()).not.toContain("a-only");
	});

	it("is idempotent — second call is no-op", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		ts.disable(pi);
		const entryCount = mock.getEntries().length;
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.disable(pi);
		expect(mock.getEntries().length).toBe(entryCount);
		expect(emitSpy).not.toHaveBeenCalled();
		emitSpy.mockRestore();
	});

	it("emits changed event with enabled: false", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.disable(pi);
		expect(emitSpy).toHaveBeenCalledWith(TOOLSET_EVENTS.changed, {
			id: "test.toolset",
			enabled: false,
		});
		emitSpy.mockRestore();
	});
});

// ===================================================================
// Invariant: disable reads from getActiveTools, not getAllTools
// ===================================================================

describe("Invariant — disable reads getActiveTools, not getAllTools", () => {
	it("disable does not re-activate tools in getAllTools but absent from getActiveTools", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a"]) }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b"]) }),
		);
		tsA.enable(pi);
		expect(mock.getActiveTools()).toEqual(["a"]);
		tsA.disable(pi);
		expect(mock.getActiveTools()).toEqual([]);
	});

	it("disable does not revive a peer that was disabled earlier", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a"]) }),
		);
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b"]) }),
		);
		tsA.enable(pi);
		tsB.enable(pi);
		tsB.disable(pi);
		expect(mock.getActiveTools()).toEqual(["a"]);
		tsA.disable(pi);
		expect(mock.getActiveTools()).toEqual([]);
	});

	it("disable of an already-absent toolset is no-op, does not revive peers", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a"]) }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b"]) }),
		);
		mock.setActiveTools(["b"]);
		const emitSpy = vi.spyOn(mock.events, "emit");
		defineToolset(
			pi,
			makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a"]) }),
		).disable(pi);
		expect(emitSpy).not.toHaveBeenCalled();
		expect(mock.getActiveTools()).toEqual(["b"]);
		emitSpy.mockRestore();
	});
});

// ===================================================================
// Toolset.isEnabled
// ===================================================================

describe("Toolset.isEnabled", () => {
	it("returns true when any member tool is active", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a", "tool-b"]) }),
		);
		expect(ts.isEnabled(pi)).toBe(false);
		mock.setActiveTools(["tool-a"]);
		expect(ts.isEnabled(pi)).toBe(true);
		mock.setActiveTools(["tool-b"]);
		expect(ts.isEnabled(pi)).toBe(true);
		mock.setActiveTools(["tool-a", "tool-b"]);
		expect(ts.isEnabled(pi)).toBe(true);
		mock.setActiveTools([]);
		expect(ts.isEnabled(pi)).toBe(false);
	});
});

// ===================================================================
// Toolset with empty names
// ===================================================================

describe("Toolset with empty names", () => {
	it("enable does nothing and does not throw", () => {
		const { mock, pi } = createEnv();
		const ts = defineToolset(pi, makeSpec({ names: new Set([]) }));
		expect(() => ts.enable(pi)).not.toThrow();
		expect(mock.getEntries().length).toBe(0);
	});

	it("disable does nothing and does not throw", () => {
		const { mock, pi } = createEnv();
		const ts = defineToolset(pi, makeSpec({ names: new Set([]) }));
		expect(() => ts.disable(pi)).not.toThrow();
		expect(mock.getEntries().length).toBe(0);
	});

	it("isEnabled returns false", () => {
		const { pi } = createEnv();
		const ts = defineToolset(pi, makeSpec({ names: new Set([]) }));
		expect(ts.isEnabled(pi)).toBe(false);
	});
});

// ===================================================================
// Peer composition (canonical test)
// ===================================================================

describe("Peer composition (canonical test)", () => {
	it("disable(A) does not re-activate B when disable(B) is called", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-only", description: "" });
		mock.registerTool({ name: "b-only", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["a-only"]) }),
		);
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "b", persistKey: "k:b", names: new Set(["b-only"]) }),
		);
		tsA.enable(pi);
		tsB.enable(pi);
		expect(mock.getActiveTools()).toEqual(
			expect.arrayContaining(["a-only", "b-only"]),
		);
		tsA.disable(pi);
		expect(mock.getActiveTools()).not.toContain("a-only");
		expect(mock.getActiveTools()).toContain("b-only");
		tsB.disable(pi);
		expect(mock.getActiveTools()).not.toContain("a-only");
		expect(mock.getActiveTools()).not.toContain("b-only");
	});

	it("disable does not revive a third disabled toolset's members", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "c-tool", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["a-tool"]) }),
		);
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "b", persistKey: "k:b", names: new Set(["b-tool"]) }),
		);
		const tsC = defineToolset(
			pi,
			makeSpec({ id: "c", persistKey: "k:c", names: new Set(["c-tool"]) }),
		);
		tsA.enable(pi);
		tsB.enable(pi);
		tsC.enable(pi);
		tsB.disable(pi);
		expect(mock.getActiveTools()).toContain("a-tool");
		expect(mock.getActiveTools()).not.toContain("b-tool");
		expect(mock.getActiveTools()).toContain("c-tool");
		tsC.disable(pi);
		expect(mock.getActiveTools()).not.toContain("c-tool");
		tsA.disable(pi);
		expect(mock.getActiveTools()).not.toContain("a-tool");
		expect(mock.getActiveTools()).not.toContain("b-tool");
		expect(mock.getActiveTools()).not.toContain("c-tool");
	});
});

// ===================================================================
// getRegisteredToolsets
// ===================================================================

describe("getRegisteredToolsets", () => {
	it("returns empty array when no toolsets registered", () => {
		const result = getRegisteredToolsets();
		expect(result).toEqual([]);
	});

	it("returns all registered toolsets with correct spec.id and toolset", () => {
		const { pi } = createEnv();
		const ts1 = defineToolset(
			pi,
			makeSpec({ id: "a.a", persistKey: "k:a.a", names: new Set(["tool-a"]) }),
		);
		const ts2 = defineToolset(
			pi,
			makeSpec({ id: "b.b", persistKey: "k:b.b", names: new Set(["tool-b"]) }),
		);

		const result = getRegisteredToolsets();
		expect(result).toHaveLength(2);

		const ids = result.map((e: RegistryEntry) => e.spec.id).sort();
		expect(ids).toEqual(["a.a", "b.b"]);

		const t1 = result.find((e: RegistryEntry) => e.spec.id === "a.a")!;
		expect(t1.toolset).toBe(ts1);
		expect(t1.toolset.isEnabled(pi)).toBe(false);

		const t2 = result.find((e: RegistryEntry) => e.spec.id === "b.b")!;
		expect(t2.toolset).toBe(ts2);
		expect(t2.toolset.isEnabled(pi)).toBe(false);
	});

	it("returns a fresh array each call (not the live Map)", () => {
		const { pi } = createEnv();
		defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["tool-a"]) }),
		);

		const snapshot1 = getRegisteredToolsets();
		const snapshot2 = getRegisteredToolsets();
		expect(snapshot1).toEqual(snapshot2);
		expect(snapshot1).not.toBe(snapshot2);

		// Registering another toolset doesn't affect the old snapshot length
		defineToolset(
			pi,
			makeSpec({ id: "b", persistKey: "k:b", names: new Set(["tool-b"]) }),
		);
		expect(snapshot1).toHaveLength(1);
		expect(getRegisteredToolsets()).toHaveLength(2);
	});

	it("entries carry working toolset handles", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["tool-a"]) }),
		);

		const entries = getRegisteredToolsets();
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;
		expect(entry.toolset.isEnabled(pi)).toBe(false);

		entry.toolset.enable(pi);
		expect(entry.toolset.isEnabled(pi)).toBe(true);

		entry.toolset.disable(pi);
		expect(entry.toolset.isEnabled(pi)).toBe(false);
	});

	it("returned type is readonly (TypeScript compile-time guarantee)", () => {
		const result: readonly RegistryEntry[] = getRegisteredToolsets();
		expect(result).toEqual([]);
		// Compile-time: result.push would fail TypeScript. Runtime array is
		// plain (not frozen) — the constraint is enforced by the type system,
		// not Object.freeze.
	});
});

// ===================================================================
// Default resolution mode
// ===================================================================

describe("Default resolution mode", () => {
	it("defaults to exclusion", () => {
		expect(getDefaultResolutionMode()).toBe("exclusion");
	});

	it("set and get inclusion mode", () => {
		const { pi } = createEnv();
		setDefaultResolutionMode(pi, "inclusion");
		expect(getDefaultResolutionMode()).toBe("inclusion");
	});

	it("set and get exclusion mode", () => {
		const { pi } = createEnv();
		setDefaultResolutionMode(pi, "exclusion");
		expect(getDefaultResolutionMode()).toBe("exclusion");
	});

	it("mode persists in globalThis shared state across calls", () => {
		const { pi } = createEnv();
		setDefaultResolutionMode(pi, "inclusion");
		expect(getDefaultResolutionMode()).toBe("inclusion");
		setDefaultResolutionMode(pi, "exclusion");
		expect(getDefaultResolutionMode()).toBe("exclusion");
	});

	it("setDefaultResolutionMode appends a durable mode entry", () => {
		const { mock, pi } = createEnv();
		setDefaultResolutionMode(pi, "inclusion");
		const entries = mock.getEntries("toolset-resolution-mode");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.data).toEqual({ mode: "inclusion" });
	});

	it("throws for invalid mode", () => {
		const { pi } = createEnv();
		expect(() => (setDefaultResolutionMode as any)(pi, "invalid")).toThrow(
			'[pi-tool-masking] Invalid defaultResolutionMode: "invalid". Must be "exclusion", "inclusion", or "allowlist".',
		);
	});
});

// ===================================================================
// Inclusion deprecation — runtime warning
// ===================================================================

describe("Inclusion mode deprecation warning", () => {
	it('setDefaultResolutionMode("inclusion") warns once; suppressed on repeat', () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi } = createEnv();
		setDefaultResolutionMode(pi, "inclusion");
		setDefaultResolutionMode(pi, "inclusion");
		setDefaultResolutionMode(pi, "exclusion");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				'"inclusion" resolution mode is deprecated since 1.2.0',
			),
		);
		warnSpy.mockRestore();
	});

	it('doRestore resolving an "inclusion" branch mode entry warns once; suppressed on repeat', () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { mock, pi } = createEnv();
		// Handler registration happens via defineToolset; the branch carries a
		// legacy "inclusion" mode entry (written before the upgrade).
		defineToolset(pi, makeSpec());
		mock.appendEntry("toolset-resolution-mode", { mode: "inclusion" });
		mock.fireLifecycleEvent("session_start");
		mock.fireLifecycleEvent("session_start");
		expect(getDefaultResolutionMode()).toBe("inclusion"); // still resolved
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				'"inclusion" resolution mode is deprecated since 1.2.0',
			),
		);
		warnSpy.mockRestore();
	});
});

// ===================================================================
// Resolution mode persistence — survives quit/resume
// ===================================================================

describe("Resolution mode persistence — survives quit/resume", () => {
	it("inclusion mode persisted on process 1 restores on a fresh process; unknown toolset defaults off", () => {
		// Process 1: focus sets inclusion mode (appends MODE_PERSIST_KEY entry)
		const { mock: mock1, pi: pi1 } = createEnv();
		setDefaultResolutionMode(pi1, "inclusion");
		expect(getDefaultResolutionMode()).toBe("inclusion");
		expect(mock1.getEntries("toolset-resolution-mode")).toHaveLength(1);

		// Simulate quit: fresh globalThis — in-memory mode reverts to exclusion
		cleanRegistry();

		// Process 2: resume — new MockPI sharing globalThis. Its branch is
		// seeded with the persisted mode entry (as the session manager would
		// load it from disk on resume).
		const { mock: mock2, pi: pi2 } = createEnv();
		mock2.registerTool({ name: "tool-a", description: "" });
		mock2.appendEntry("toolset-resolution-mode", { mode: "inclusion" });
		// A toolset registered post-focus with no persisted {enabled} entry.
		// defaultEnabled: true would turn it ON in exclusion mode — the drift
		// bug. Inclusion mode must hold it OFF.
		defineToolset(
			pi2,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);

		// Fresh process: in-memory mode is still exclusion until restore runs
		expect(getDefaultResolutionMode()).toBe("exclusion");

		mock2.fireLifecycleEvent("session_start");

		// Restore replayed the persisted mode entry BEFORE per-toolset fallback,
		// so inclusion holds and the unknown toolset restores off.
		expect(getDefaultResolutionMode()).toBe("inclusion");
		expect(mock2.getActiveTools()).not.toContain("tool-a");
	});
});

// ===================================================================
// Allowlist resolution mode
// ===================================================================

describe("Allowlist resolution mode", () => {
	it("AL1: setDefaultResolutionMode persists the array; getActiveAllowlist reads it", () => {
		const { mock, pi } = createEnv();
		setDefaultResolutionMode(pi, "allowlist", [
			"my-plugin.web",
			"my-plugin.learn",
		]);

		expect(getDefaultResolutionMode()).toBe("allowlist");
		expect(getActiveAllowlist()).toEqual(["my-plugin.web", "my-plugin.learn"]);
		const entries = mock.getEntries("toolset-resolution-mode");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.data).toEqual({
			mode: "allowlist",
			allowlist: ["my-plugin.web", "my-plugin.learn"],
		});
	});

	it("AL2: restore under allowlist — members on, others off; stale branch entry and settings pin bypassed", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		mock.registerTool({ name: "tool-c", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["tool-a"]) }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "b", persistKey: "k:b", names: new Set(["tool-b"]) }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "c", persistKey: "k:c", names: new Set(["tool-c"]) }),
		);

		// Stale branch entry (bypassed) and settings pin (bypassed) must both lose
		// to the set-level allowlist override.
		mock.appendEntry("k:b", { enabled: true });
		setSettingsOverrideForTests({ "k:c": { enabled: true } });

		setDefaultResolutionMode(pi, "allowlist", ["a"]);
		// Real pi activates every extension tool at startup, THEN restore runs.
		mock.setActiveTools(["tool-a", "tool-b", "tool-c"]);

		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toEqual(["tool-a"]);
	});

	it("AL3 (B1): non-toolset tools preserved during allowlist restore", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "orphan-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["tool-a"]) }),
		);

		setDefaultResolutionMode(pi, "allowlist", ["a"]);
		mock.setActiveTools(["tool-a", "orphan-tool"]);

		mock.fireLifecycleEvent("session_start");

		// orphan-tool is not owned by any registered toolset — the library does
		// not govern it and must leave it active (`setActiveTools` is a full
		// replacement, so the short-circuit computes a delta from current).
		expect(mock.getActiveTools()).toEqual(["tool-a", "orphan-tool"]);
	});

	it("AL4: future-install suppression — toolset registered after allowlist is off", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["tool-a"]) }),
		);

		setDefaultResolutionMode(pi, "allowlist", ["a"]);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toEqual(["tool-a"]);

		// Toolset installed AFTER focus was entered (a consumer's actuation
		// path consults getActiveAllowlist() — the library has no actuation
		// surface, so the consultation is simulated here).
		defineToolset(
			pi,
			makeSpec({
				id: "b",
				persistKey: "k:b",
				names: new Set(["tool-b"]),
				defaultEnabled: true,
			}),
		);
		expect(getActiveAllowlist()).toEqual(["a"]); // b not in the array → off

		// Simulate actuation turning the new toolset on, then the next restore
		// suppresses it.
		mock.setActiveTools(["tool-a", "tool-b"]);
		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toEqual(["tool-a"]);
	});

	it("AL5: later exclusion entry supersedes the allowlist; per-toolset tiering resumes", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "k:a",
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "b",
				persistKey: "k:b",
				names: new Set(["tool-b"]),
				defaultEnabled: true,
			}),
		);

		setDefaultResolutionMode(pi, "allowlist", ["a"]);
		mock.setActiveTools(["tool-a", "tool-b"]);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toEqual(["tool-a"]);

		// Focus lifted: exclusion supersedes the array; tiering resumes.
		setDefaultResolutionMode(pi, "exclusion");
		expect(getActiveAllowlist()).toBeUndefined();

		mock.setActiveTools(["tool-a", "tool-b"]);
		mock.fireLifecycleEvent("session_start");

		// No branch entry, no settings pin → exclusion floor (`defaultEnabled ?? true`).
		expect(mock.getActiveTools()).toEqual(["tool-a", "tool-b"]);
	});

	it("AL6: validation — missing/empty allowlist throws; unregistered ids allowed", () => {
		const { pi } = createEnv();
		expect(() => setDefaultResolutionMode(pi, "allowlist")).toThrow(
			'[pi-tool-masking] defaultResolutionMode "allowlist" requires a non-empty allowlist array of toolset ids.',
		);
		expect(() => setDefaultResolutionMode(pi, "allowlist", [])).toThrow(
			'[pi-tool-masking] defaultResolutionMode "allowlist" requires a non-empty allowlist array of toolset ids.',
		);
		// Forward references are legal — registration may come later.
		expect(() =>
			setDefaultResolutionMode(pi, "allowlist", ["not-registered"]),
		).not.toThrow();
		expect(getActiveAllowlist()).toEqual(["not-registered"]);
	});

	it("AL7: changed-mirror companion never fires during allowlist restore (two-phase)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "base-tool", description: "" });
		mock.registerTool({ name: "comp-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "base",
				persistKey: "k:base",
				names: new Set(["base-tool"]),
			}),
		);
		const comp = defineToolset(
			pi,
			makeSpec({
				id: "comp",
				persistKey: "k:comp",
				names: new Set(["comp-tool"]),
			}),
		);

		// Companion mirror on `changed` (the standard pattern).
		pi.events.on(TOOLSET_EVENTS.changed, (data: any) => {
			if (data.id === "base") {
				if (data.enabled) comp.enable(pi);
				else comp.disable(pi);
			}
		});

		setDefaultResolutionMode(pi, "allowlist", ["base"]);
		mock.setActiveTools(["base-tool", "comp-tool"]);

		mock.fireLifecycleEvent("session_start");

		// Authoritative state: base on, comp off.
		expect(mock.getActiveTools()).toEqual(["base-tool"]);
		// The mirror fires only on `changed`; allowlist restore emits `restored`
		// in phase 2, so the mirror never appendEntry'd an `{enabled:true}` for
		// comp mid-restore.
		expect(mock.getEntries("k:comp")).toHaveLength(0);
	});

	it("AL8: restore fail-closed — mode entry claims allowlist with no array → empty allowlist, everything off", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "k:a",
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
		);

		// Hand-edited branch corruption: mode claims "allowlist", array missing
		// (write-time validation would prevent this, but branch files are
		// hand-editable).
		mock.appendEntry("toolset-resolution-mode", { mode: "allowlist" });
		mock.setActiveTools(["tool-a"]);

		mock.fireLifecycleEvent("session_start");

		// Mode claim respected — not silently rewritten to "exclusion"...
		expect(getDefaultResolutionMode()).toBe("allowlist");
		// ...recovered to an empty array (consistent, not undefined)...
		expect(getActiveAllowlist()).toEqual([]);
		// ...and the recovery fails CLOSED: nothing is on. (Recovering to
		// "exclusion" instead would fail open — `defaultEnabled: true` would
		// have turned tool-a on.)
		expect(mock.getActiveTools()).toEqual([]);
	});

	it("AL9: restore fail-closed — allowlist present but not an array → empty allowlist, everything off", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "k:a",
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
		);

		mock.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: "tool-a", // not an array
		});
		mock.setActiveTools(["tool-a"]);

		mock.fireLifecycleEvent("session_start");

		expect(getDefaultResolutionMode()).toBe("allowlist");
		expect(getActiveAllowlist()).toEqual([]);
		expect(mock.getActiveTools()).toEqual([]);
	});

	it("AL10: null-tombstoned mode entry supersedes a prior allowlist → exclusion, allowlist undefined", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "k:a",
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
		);

		// Focus was active (allowlist), then a mode tombstone — the tombstone is
		// the LAST mode entry and must beat the stale prior allowlist (null-tombstone
		// awareness; unreachable today since no API tombstones
		// the mode entry, kept as a defensive guard).
		mock.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: ["a"],
		});
		mock.appendEntry("toolset-resolution-mode", null);
		mock.setActiveTools(["tool-a"]);

		mock.fireLifecycleEvent("session_start");

		// Fall through to "exclusion" — no mode resurrection from the stale entry.
		expect(getDefaultResolutionMode()).toBe("exclusion");
		expect(getActiveAllowlist()).toBeUndefined();
		// Per-toolset tiering resumes: no entry, no pin → exclusion floor
		// (`defaultEnabled ?? true`).
		expect(mock.getActiveTools()).toEqual(["tool-a"]);
	});

	it("AL11: mode absent / unknown value in the last entry falls through to exclusion; allowlist undefined", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "k:a",
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
		);

		mock.appendEntry("toolset-resolution-mode", {}); // no `mode` field
		mock.setActiveTools(["tool-a"]);

		mock.fireLifecycleEvent("session_start");

		expect(getDefaultResolutionMode()).toBe("exclusion");
		expect(getActiveAllowlist()).toBeUndefined();
		expect(mock.getActiveTools()).toEqual(["tool-a"]);
	});

	it("AL12: getActiveAllowlist() is undefined under inclusion", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		// A toolset must exist — defineToolset registers the restore handler.
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "k:a",
				names: new Set(["tool-a"]),
			}),
		);
		mock.appendEntry("toolset-resolution-mode", { mode: "inclusion" });

		mock.fireLifecycleEvent("session_start");

		expect(getDefaultResolutionMode()).toBe("inclusion");
		expect(getActiveAllowlist()).toBeUndefined();
	});
});

// ===================================================================
// Dependency cascade on enable
// ===================================================================

describe("Dependency cascade on enable", () => {
	it("L requires [B]; enable(L) → B enabled", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		tsL.enable(pi);
		expect(mock.getActiveTools()).toContain("b-tool");
		expect(mock.getActiveTools()).toContain("l-tool");
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(tsL.isEnabled(pi)).toBe(true);
	});

	it("disable(B) → L disabled (reverse cascade)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		tsL.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(tsL.isEnabled(pi)).toBe(true);
		tsB.disable(pi);
		expect(tsB.isEnabled(pi)).toBe(false);
		expect(tsL.isEnabled(pi)).toBe(false);
		expect(mock.getActiveTools()).not.toContain("b-tool");
		expect(mock.getActiveTools()).not.toContain("l-tool");
	});

	it("enable(L) while B independently disabled re-enables B", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		tsB.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);
		tsB.disable(pi);
		expect(tsB.isEnabled(pi)).toBe(false);
		tsL.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(tsL.isEnabled(pi)).toBe(true);
		expect(mock.getActiveTools()).toContain("b-tool");
		expect(mock.getActiveTools()).toContain("l-tool");
	});

	it("no path yields L.enabled && !B.enabled (invariant)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		tsL.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);
		// Directly remove B's tool (simulates external interference)
		const withoutB = mock
			.getActiveTools()
			.filter((n: string) => n !== "b-tool");
		mock.setActiveTools(withoutB);
		expect(tsB.isEnabled(pi)).toBe(false);
		expect(tsL.isEnabled(pi)).toBe(true);
		// Re-enable L restores the invariant
		tsL.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);
	});

	it("cascade writes appendEntry for the dependency, not just the caller", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		tsL.enable(pi);
		const bEntries = mock.getEntries("k:B");
		expect(bEntries).toHaveLength(1);
		expect(bEntries[0]?.data).toEqual({ enabled: true });
	});

	it('duplicate requires ids (["B", "B"]) does not double-enable or throw', () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B", "B"],
			}),
		);
		tsL.enable(pi);
		expect(mock.getActiveTools()).toContain("b-tool");
		expect(mock.getActiveTools()).toContain("l-tool");
		const bEntries = mock.getEntries("k:B");
		expect(bEntries).toHaveLength(1);
	});
});

// ===================================================================
// Cascade appendEntry consistency
// ===================================================================

describe("Cascade appendEntry consistency", () => {
	it("enable(L) writes one entry for L and one for B (dependency)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		tsL.enable(pi);
		expect(mock.getEntries("k:L")).toHaveLength(1);
		expect(mock.getEntries("k:B")).toHaveLength(1);
	});

	it("disable cascades write entries for each affected toolset", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		tsL.enable(pi);
		tsB.disable(pi);
		const lEntries = mock.getEntries("k:L");
		expect(lEntries).toHaveLength(2);
		expect(lEntries[1]?.data).toEqual({ enabled: false });
		const bEntries = mock.getEntries("k:B");
		expect(bEntries).toHaveLength(2);
		expect(bEntries[1]?.data).toEqual({ enabled: false });
	});
});

// ===================================================================
// Cycle detection on enable
// ===================================================================

describe("Cycle detection on enable", () => {
	it("throws on direct cycle (A → B → A)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set([]),
				requires: ["A"],
			}),
		);
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		expect(() => tsA.enable(pi)).toThrow("Cycle detected");
	});

	it("cycle error message includes the full path", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				requires: ["C"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "C",
				persistKey: "k:C",
				names: new Set([]),
				requires: ["A"],
			}),
		);
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		let error: Error | undefined;
		try {
			tsA.enable(pi);
		} catch (e) {
			error = e as Error;
		}
		expect(error).toBeDefined();
		expect(error!.message).toMatch(/A → B → C → A/);
	});

	it("does not throw on diamond pattern (shared dependency)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "d-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "c-tool", description: "" });
		mock.registerTool({ name: "a-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "D", persistKey: "k:D", names: new Set(["d-tool"]) }),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				requires: ["D"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "C",
				persistKey: "k:C",
				names: new Set(["c-tool"]),
				requires: ["D"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B", "C"],
			}),
		);
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B", "C"],
			}),
		);
		expect(() => tsA.enable(pi)).not.toThrow();
		expect(mock.getActiveTools()).toContain("a-tool");
		expect(mock.getActiveTools()).toContain("b-tool");
		expect(mock.getActiveTools()).toContain("c-tool");
		expect(mock.getActiveTools()).toContain("d-tool");
	});

	it("throws on self-require (A → A)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["A"],
			}),
		);
		expect(() => tsA.enable(pi)).toThrow("Cycle detected");
	});
});

// ===================================================================
// Forward references
// ===================================================================

describe("Forward references", () => {
	it("defineToolset with forward ref does not throw on enable", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		expect(() => tsA.enable(pi)).not.toThrow();
		expect(tsA.isEnabled(pi)).toBe(true);
	});

	it("re-enable after forward ref is registered cascades to it", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		tsA.enable(pi);
		expect(mock.getActiveTools()).toEqual(["a-tool"]);
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		expect(tsB.isEnabled(pi)).toBe(false);
		tsA.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(mock.getActiveTools()).toContain("a-tool");
		expect(mock.getActiveTools()).toContain("b-tool");
	});
});

// ===================================================================
// Reverse cascade on disable
// ===================================================================

describe("Reverse cascade on disable", () => {
	it("linear chain: A requires B requires C — disable(B) cascades to A but not C", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "c-tool", description: "" });
		const tsC = defineToolset(
			pi,
			makeSpec({ id: "C", persistKey: "k:C", names: new Set(["c-tool"]) }),
		);
		const tsB = defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				requires: ["C"],
			}),
		);
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		tsA.enable(pi);
		expect(tsA.isEnabled(pi)).toBe(true);
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(tsC.isEnabled(pi)).toBe(true);
		tsB.disable(pi);
		expect(tsB.isEnabled(pi)).toBe(false);
		expect(tsA.isEnabled(pi)).toBe(false);
		expect(tsC.isEnabled(pi)).toBe(true);
	});

	it("reverse cascade is idempotent — second disable is no-op", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsL = defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		tsL.enable(pi);
		tsB.disable(pi);
		const entryCount = mock.getEntries().length;
		const activeAfterFirst = mock.getActiveTools();
		tsB.disable(pi);
		expect(mock.getEntries().length).toBe(entryCount);
		expect(mock.getActiveTools()).toEqual(activeAfterFirst);
	});

	it("multi-level reverse cascade: X requires A, A requires B — disable(B) cascades through A to X", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "x-tool", description: "" });
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		const tsX = defineToolset(
			pi,
			makeSpec({
				id: "X",
				persistKey: "k:X",
				names: new Set(["x-tool"]),
				requires: ["A"],
			}),
		);
		tsX.enable(pi);
		expect(tsX.isEnabled(pi)).toBe(true);
		expect(tsA.isEnabled(pi)).toBe(true);
		expect(tsB.isEnabled(pi)).toBe(true);
		tsB.disable(pi);
		expect(tsB.isEnabled(pi)).toBe(false);
		expect(tsA.isEnabled(pi)).toBe(false);
		expect(tsX.isEnabled(pi)).toBe(false);
	});
});

// ===================================================================
// Cycle detection on disable
// ===================================================================

describe("Cycle detection on disable", () => {
	it("throws on enable of a toolset in a cycle", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				requires: ["A"],
			}),
		);
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		expect(() => tsA.enable(pi)).toThrow("Cycle detected");
	});

	it("throws on disable of a toolset in a reverse cycle", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				requires: ["A"],
			}),
		);
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		// Note: _applyDisable(self) for A runs before the throw (a side effect),
		// but the assertion is only on the throw, which is fine.
		expect(() => tsA.disable(pi)).toThrow("Cycle detected on disable");
	});
});

// ===================================================================
// Restore — persistence round-trip
// ===================================================================

describe("Restore — persistence round-trip", () => {
	it("disable writes { enabled: false } under persistKey", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		ts.disable(pi);
		const entries = mock.getEntries("toolset-state:test.toolset");
		const last = entries[entries.length - 1];
		expect(last?.data).toEqual({ enabled: false });
	});

	it("restore reads persisted false, applies it, emits restored", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		ts.disable(pi);
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(restoredCalls.length).toBeGreaterThanOrEqual(1);
		const payload = restoredCalls[0]?.[1] as any;
		expect(payload).toMatchObject({ id: "test.toolset", enabled: false });
		emitSpy.mockRestore();
	});

	it("restore reads persisted true and keeps it enabled", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("tool-a");
	});

	it("restore disable removes unregistered spec members (matching _applyDisable)", () => {
		const { mock, pi } = createEnv();
		// Spec names "unreg-tool" but it's never registered with registerTool
		const ts = defineToolset(
			pi,
			makeSpec({
				id: "with-unreg",
				persistKey: "k:with-unreg",
				names: new Set(["tool-a", "unreg-tool"]),
			}),
		);
		mock.registerTool({ name: "tool-a", description: "" });
		ts.enable(pi);
		// "unreg-tool" wasn't added (not registered), so manually inject it
		// to simulate an externally-added tool matching a spec name
		mock.setActiveTools(["tool-a", "unreg-tool"]);

		// Persist disabled and restore
		mock.appendEntry("k:with-unreg", { enabled: false });
		mock.fireLifecycleEvent("session_start");

		// Both should be removed: tool-a (registered, removed by spec.names.has)
		// and unreg-tool (unregistered, also removed by spec.names.has)
		expect(mock.getActiveTools()).not.toContain("tool-a");
		expect(mock.getActiveTools()).not.toContain("unreg-tool");
	});
});

// ===================================================================
// Restore — no entry (default fallback)
// ===================================================================

describe("Restore — no entry (default fallback)", () => {
	it("exclusion mode with defaultEnabled: true → applies on, emits changed", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		const entryCountBefore = mock.getEntries().length;
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("tool-a");
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(restoredCalls.length).toBe(0);
		expect(mock.getEntries().length).toBe(entryCountBefore);
		emitSpy.mockRestore();
	});

	it("exclusion mode with defaultEnabled: false → applies off", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("inclusion mode → defaults off regardless of defaultEnabled", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setDefaultResolutionMode(pi, "inclusion");
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("inclusion mode emits changed (not restored) and does not persist", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setDefaultResolutionMode(pi, "inclusion");
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		const entryCountBefore = mock.getEntries().length;
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(restoredCalls.length).toBe(0);
		expect(mock.getEntries().length).toBe(entryCountBefore);
		emitSpy.mockRestore();
	});

	it("no-entry restore does not call appendEntry (entry count unchanged)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		const entryCountBefore = mock.getEntries().length;
		mock.fireLifecycleEvent("session_start");
		expect(mock.getEntries().length).toBe(entryCountBefore);
	});
});

// ===================================================================
// Restore — always-emit invariant
// ===================================================================

describe("Restore — always-emit invariant", () => {
	it("restore emits one event per registered toolset always", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "t1", description: "" });
		mock.registerTool({ name: "t2", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "ts1", persistKey: "k:ts1", names: new Set(["t1"]) }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "ts2", persistKey: "k:ts2", names: new Set(["t2"]) }),
		);
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		const totalEvents = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed || c === TOOLSET_EVENTS.restored,
		).length;
		expect(totalEvents).toBeGreaterThanOrEqual(2);
		emitSpy.mockRestore();
	});

	it("restore emits even when resolved state matches current in-memory state", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		mock.setActiveTools(["tool-a"]);
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		emitSpy.mockRestore();
	});
});

// ===================================================================
// Restore — event split changed vs restored
// ===================================================================

describe("Restore — event split changed vs restored", () => {
	it("enable emits changed (not restored)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const emitSpy = vi.spyOn(mock.events, "emit");
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		expect(restoredCalls.length).toBe(0);
		emitSpy.mockRestore();
	});

	it("disable emits changed (not restored)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.disable(pi);
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		expect(restoredCalls.length).toBe(0);
		emitSpy.mockRestore();
	});

	it("default-fallback restore emits changed (not restored)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		expect(restoredCalls.length).toBe(0);
		emitSpy.mockRestore();
	});

	it("restored event payload carries id and enabled (no member)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({
				id: "my.test",
				persistKey: "k:my.test",
				names: new Set(["tool-a"]),
			}),
		);
		ts.enable(pi);
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		const payload = restoredCalls[0]?.[1] as any;
		expect(payload.id).toBe("my.test");
		expect(typeof payload.enabled).toBe("boolean");
		expect(payload.member).toBeUndefined();
		emitSpy.mockRestore();
	});
});

// ===================================================================
// emitMemberEvents
// ===================================================================

describe("emitMemberEvents", () => {
	it("true produces N+1 events on enable (1 group + N members)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({ names: new Set(["a", "b"]), emitMemberEvents: true }),
		);
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.enable(pi);
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBe(3);
		emitSpy.mockRestore();
	});

	it("false produces 1 group event on enable", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({ names: new Set(["a", "b"]), emitMemberEvents: false }),
		);
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.enable(pi);
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBe(1);
		emitSpy.mockRestore();
	});

	it("member events carry event.member set to the tool name", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({ names: new Set(["a", "b"]), emitMemberEvents: true }),
		);
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.enable(pi);
		const memberCalls = emitSpy.mock.calls
			.filter(([c, d]) => c === TOOLSET_EVENTS.changed && (d as any).member)
			.map(([, d]) => (d as any).member as string)
			.sort();
		expect(memberCalls).toEqual(["a", "b"]);
		emitSpy.mockRestore();
	});

	it("group event still fires (with no member field) when emitMemberEvents is true", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({ names: new Set(["a", "b"]), emitMemberEvents: true }),
		);
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.enable(pi);
		const groupCalls = emitSpy.mock.calls.filter(
			([c, d]) => c === TOOLSET_EVENTS.changed && !(d as any).member,
		);
		expect(groupCalls.length).toBe(1);
		expect(groupCalls[0]?.[1]).toMatchObject({
			id: "test.toolset",
			enabled: true,
		});
		emitSpy.mockRestore();
	});

	it("member events also fire on disable", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({ names: new Set(["a", "b"]), emitMemberEvents: true }),
		);
		ts.enable(pi);
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.disable(pi);
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBe(3);
		emitSpy.mockRestore();
	});

	it("member events fire on restore (for both changed and restored)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({ names: new Set(["a", "b"]), emitMemberEvents: true }),
		);
		ts.enable(pi);
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(restoredCalls.length).toBe(3);
		const memberRestored = restoredCalls.filter(
			([, d]) => (d as any).member != null,
		);
		expect(memberRestored.length).toBe(2);
		emitSpy.mockRestore();
	});
});

// ===================================================================
// Restore — idempotent / last-writer-wins
// ===================================================================

describe("Restore — idempotent / last-writer-wins", () => {
	it("second restore on same branch produces same state", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		mock.fireLifecycleEvent("session_start");
		const stateAfterFirst = [...mock.getActiveTools()];
		mock.fireLifecycleEvent("session_start");
		const stateAfterSecond = [...mock.getActiveTools()];
		expect(stateAfterSecond).toEqual(stateAfterFirst);
	});

	it("second restore does not double-write appendEntry", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		mock.fireLifecycleEvent("session_start");
		const entriesAfterFirst = mock.getEntries().length;
		mock.fireLifecycleEvent("session_start");
		const entriesAfterSecond = mock.getEntries().length;
		expect(entriesAfterSecond).toBe(entriesAfterFirst);
	});

	it("last-writer-wins: most recent entry takes precedence", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		ts.disable(pi);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});
});

// ===================================================================
// Restore — session_tree
// ===================================================================

describe("Restore — session_tree", () => {
	it("session_tree also triggers restore", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_tree");
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		emitSpy.mockRestore();
	});

	it("session_tree restores persisted entry and emits restored", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi);
		ts.disable(pi);
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_tree");
		expect(mock.getActiveTools()).not.toContain("tool-a");
		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(restoredCalls.length).toBeGreaterThanOrEqual(1);
		expect(restoredCalls[0]?.[1]).toMatchObject({
			id: "test.toolset",
			enabled: false,
		});
		emitSpy.mockRestore();
	});

	it("session_start followed by session_tree both trigger restore (different event objects)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		mock.setActiveTools([]);
		const emitSpy = vi.spyOn(mock.events, "emit");

		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("tool-a");
		const afterStart = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		).length;

		// Reset and fire session_tree — should re-run restore (fresh event object)
		mock.setActiveTools([]);
		mock.fireLifecycleEvent("session_tree");
		expect(mock.getActiveTools()).toContain("tool-a");
		const afterTree = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		).length;
		expect(afterTree).toBe(afterStart + 1);

		emitSpy.mockRestore();
	});
});

// ===================================================================
// Restore independence with requires
// ===================================================================

describe("Restore independence — does not cascade", () => {
	it("restore applies persisted entries independently without cascading requires", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "L",
				persistKey: "k:L",
				names: new Set(["l-tool"]),
				requires: ["B"],
			}),
		);
		// Enable both, then manually persist an "incoherent" combo
		// that the live cascade would prevent but restore should honor.
		tsB.enable(pi);
		// Manually inject persisted entries for B (disabled) and L (enabled)
		mock.appendEntry("k:B", { enabled: false });
		mock.appendEntry("k:L", { enabled: true });
		// Clear active tools to simulate a fresh session state
		mock.setActiveTools([]);
		mock.fireLifecycleEvent("session_start");
		// Restore should apply each entry independently:
		// B gets its persisted false, L gets its persisted true.
		// No cascade runs — L does not re-enable B, and B being off
		// does not push L off.
		expect(tsB.isEnabled(pi)).toBe(false);
		expect(mock.getActiveTools()).not.toContain("b-tool");
		expect(mock.getActiveTools()).toContain("l-tool");
	});
});

// ===================================================================
// Default-resolution mode — entry vs no-entry
// ===================================================================

describe("Default-resolution mode — entry vs no-entry", () => {
	it("toolset A (with entry) B (no entry): mode affects B but not A", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				defaultEnabled: false,
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				defaultEnabled: true,
			}),
		);
		tsA.enable(pi);
		setDefaultResolutionMode(pi, "inclusion");
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("a-tool");
		expect(mock.getActiveTools()).not.toContain("b-tool");
	});

	it("exclusion mode: B (no entry, defaultEnabled: true) defaults on", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				defaultEnabled: true,
			}),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("b-tool");
	});
});

// ===================================================================
// Entry-point exports
// ===================================================================

describe("Entry-point exports", () => {
	it("all public exports resolve from the package entry", () => {
		expect(typeof defineToolset).toBe("function");
		expect(typeof setDefaultResolutionMode).toBe("function");
		expect(typeof getDefaultResolutionMode).toBe("function");

		expect(typeof TOOLSET_EVENTS).toBe("object");
		expect(typeof TOOLSET_EVENTS.changed).toBe("string");
		expect(typeof TOOLSET_EVENTS.restored).toBe("string");
	});
});

// ===================================================================
// Settings.json reader — parseToolsetDefaults
// ===================================================================

describe("parseToolsetDefaults", () => {
	it("absent toolsetDefaults returns {}", () => {
		expect(parseToolsetDefaults({})).toEqual({});
	});

	it("non-object toolsetDefaults (string) returns {}", () => {
		expect(parseToolsetDefaults({ toolsetDefaults: "" })).toEqual({});
	});

	it("non-object toolsetDefaults (array) returns {}", () => {
		expect(parseToolsetDefaults({ toolsetDefaults: [] })).toEqual({});
	});

	it("drops entry with string enabled value", () => {
		expect(
			parseToolsetDefaults({ toolsetDefaults: { "k:x": { enabled: "true" } } }),
		).toEqual({});
	});

	it("drops entry with number enabled value", () => {
		expect(
			parseToolsetDefaults({ toolsetDefaults: { "k:x": { enabled: 1 } } }),
		).toEqual({});
	});

	it("keeps valid entry with extra fields (extra ignored)", () => {
		const input = {
			toolsetDefaults: {
				"k:extra": { enabled: true, extra: 1 },
			},
		};
		expect(parseToolsetDefaults(input)).toEqual({
			"k:extra": { enabled: true },
		});
	});

	it("returns the on-disk shape, not flattened booleans", () => {
		const input = {
			toolsetDefaults: {
				"k:a": { enabled: true },
				"k:b": { enabled: false },
			},
		};
		expect(parseToolsetDefaults(input)).toEqual({
			"k:a": { enabled: true },
			"k:b": { enabled: false },
		});
	});
});

// ===================================================================
// Settings.json reader — mergeToolsetDefaults
// ===================================================================

describe("mergeToolsetDefaults", () => {
	it("shallow per-key merge: project wins on collision", () => {
		const global_ = {
			"k:a": { enabled: true },
			"k:b": { enabled: false },
		};
		const project = { "k:b": { enabled: true } };
		expect(mergeToolsetDefaults(global_, project)).toEqual({
			"k:a": { enabled: true },
			"k:b": { enabled: true },
		});
	});

	it("empty project does not clobber global", () => {
		expect(mergeToolsetDefaults({ "k:a": { enabled: true } }, {})).toEqual({
			"k:a": { enabled: true },
		});
	});

	it("empty global is populated by project", () => {
		expect(mergeToolsetDefaults({}, { "k:a": { enabled: true } })).toEqual({
			"k:a": { enabled: true },
		});
	});
});

// ===================================================================
// Settings.json reader — readMergedToolsetDefaults / readToolsetDefaults
// ===================================================================

describe("readMergedToolsetDefaults / readToolsetDefaults", () => {
	it("returns the override verbatim when set", () => {
		setSettingsOverrideForTests({ "k:a": { enabled: false } });
		expect(readMergedToolsetDefaults()).toEqual({ "k:a": { enabled: false } });
		expect(readToolsetDefaults("global")).toEqual({
			"k:a": { enabled: false },
		});
		expect(readToolsetDefaults("project")).toEqual({
			"k:a": { enabled: false },
		});
	});

	it("returns {} when override is empty", () => {
		setSettingsOverrideForTests({});
		expect(readMergedToolsetDefaults()).toEqual({});
	});

	it("returns a copy, not the override object itself", () => {
		const seed = { "k:a": { enabled: true } };
		setSettingsOverrideForTests(seed);
		const out = readMergedToolsetDefaults();
		expect(out).toEqual(seed);
		expect(out).not.toBe(seed);
	});
});

// ===================================================================
// Settings.json writer — writeToolsetDefaults / clearToolsetDefaults
// ===================================================================

describe("writeToolsetDefaults & clearToolsetDefaults", () => {
	// W1–W3, W5 use the writer seam; W4, W6–W8 hit disk

	beforeEach(() => {
		setSettingsWriterOverrideForTests({ global: {}, project: {} });
	});

	afterEach(() => {
		setSettingsWriterOverrideForTests(null);
	});

	it("W1: writeToolsetDefaults merges entries into scope, preserves existing keys", () => {
		const state = {
			global: { "toolset-state:z": { enabled: true } },
			project: {},
		};
		setSettingsWriterOverrideForTests(state);
		try {
			writeToolsetDefaults(
				{
					"toolset-state:x": { enabled: true },
					"toolset-state:y": { enabled: false },
				},
				"global",
			);
			expect(state.global).toEqual({
				"toolset-state:z": { enabled: true },
				"toolset-state:x": { enabled: true },
				"toolset-state:y": { enabled: false },
			});
			expect(state.project).toEqual({});
		} finally {
			setSettingsWriterOverrideForTests(null);
		}
	});

	it("W2: writing to project does not touch global, and vice versa", () => {
		const state = { global: {}, project: {} };
		setSettingsWriterOverrideForTests(state);
		try {
			writeToolsetDefaults({ "toolset-state:x": { enabled: true } }, "project");
			expect(state.global).toEqual({});
			expect(state.project).toEqual({ "toolset-state:x": { enabled: true } });

			writeToolsetDefaults({ "toolset-state:y": { enabled: false } }, "global");
			expect(state.global).toEqual({ "toolset-state:y": { enabled: false } });
			expect(state.project).toEqual({ "toolset-state:x": { enabled: true } });
		} finally {
			setSettingsWriterOverrideForTests(null);
		}
	});

	it("W3: clearToolsetDefaults empties scope and returns path (null when empty)", () => {
		const state = {
			global: {
				"toolset-state:x": { enabled: true },
				"toolset-state:y": { enabled: false },
			},
			project: {},
		};
		setSettingsWriterOverrideForTests(state);
		try {
			expect(clearToolsetDefaults("global")).toEqual(
				expect.stringContaining("settings.json"),
			);
			expect(state.global).toEqual({});

			expect(clearToolsetDefaults("global")).toBeNull();

			expect(clearToolsetDefaults("project")).toBeNull();
		} finally {
			setSettingsWriterOverrideForTests(null);
		}
	});

	it("W5: writer override and reader override are independent", () => {
		const writerState = {
			global: { "toolset-state:writer": { enabled: true } },
			project: {},
		};
		setSettingsWriterOverrideForTests(writerState);
		setSettingsOverrideForTests({ "toolset-state:reader": { enabled: false } });
		try {
			// Reader returns the reader override, not writer-captured state
			const merged = readMergedToolsetDefaults();
			expect(merged["toolset-state:reader"]).toEqual({ enabled: false });
			expect(merged["toolset-state:writer"]).toBeUndefined();
		} finally {
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests({});
		}
	});

	// W4 — write→read round-trip on disk
	describe("W4: disk round-trip (writeToolsetDefaults + readMergedToolsetDefaults)", () => {
		let tmpDir: string;
		let agentDir: string;
		let origCwd: string;
		let origAgentDir: string | undefined;

		beforeEach(() => {
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests(null);

			tmpDir = mkdtempSync(join(tmpdir(), "pi-tool-masking-w4-"));
			agentDir = join(tmpDir, "agent");
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			origCwd = process.cwd();
			origAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.chdir(tmpDir);
		});

		afterEach(() => {
			process.chdir(origCwd);
			if (origAgentDir !== undefined) {
				process.env.PI_CODING_AGENT_DIR = origAgentDir;
			} else {
				delete process.env.PI_CODING_AGENT_DIR;
			}
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests({});
		});

		it("W4a: write→readMergedToolsetDefaults round-trip (project overrides global)", () => {
			const globalPath = join(agentDir, "settings.json");
			writeFileSync(
				globalPath,
				JSON.stringify({
					toolsetDefaults: {
						"toolset-state:shared": { enabled: false },
					},
				}) + "\n",
			);

			writeToolsetDefaults(
				{ "toolset-state:new": { enabled: true } },
				"project",
			);
			writeToolsetDefaults(
				{ "toolset-state:shared": { enabled: true } },
				"project",
			);

			const merged = readMergedToolsetDefaults();
			expect(merged["toolset-state:shared"]).toEqual({ enabled: true });
			expect(merged["toolset-state:new"]).toEqual({ enabled: true });
			expect(merged["toolset-state:missing"]).toBeUndefined();
		});

		it("W4b: readToolsetDefaults attributes to the correct scope", () => {
			// Global has an entry; project has no file yet
			const globalPath = join(agentDir, "settings.json");
			writeFileSync(
				globalPath,
				JSON.stringify({
					toolsetDefaults: {
						"toolset-state:x": { enabled: true },
					},
				}) + "\n",
			);

			// project doesn't exist yet — readToolsetDefaults returns {}
			expect(readToolsetDefaults("project")).toEqual({});

			// Write only to project
			writeToolsetDefaults(
				{ "toolset-state:y": { enabled: false } },
				"project",
			);

			// Per-scope readers are independent
			expect(readToolsetDefaults("global")).toEqual({
				"toolset-state:x": { enabled: true },
			});
			expect(readToolsetDefaults("project")).toEqual({
				"toolset-state:y": { enabled: false },
			});

			// Merged returns project-overrides-global
			expect(readMergedToolsetDefaults()["toolset-state:x"]).toEqual({
				enabled: true,
			});
			expect(readMergedToolsetDefaults()["toolset-state:y"]).toEqual({
				enabled: false,
			});
		});
	});

	// W6 — malformed-file guard (disk)
	describe("W6: malformed-file guard (disk)", () => {
		let tmpDir: string;
		let origCwd: string;

		beforeEach(() => {
			// Clear both overrides so reads and writes hit disk
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests(null);

			tmpDir = mkdtempSync(join(tmpdir(), "pi-tool-masking-writer-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });
			origCwd = process.cwd();
			process.chdir(tmpDir);
		});

		afterEach(() => {
			process.chdir(origCwd);
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests({});
		});

		it("W6a: writeToolsetDefaults throws on malformed JSON", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "{not valid");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() =>
				writeToolsetDefaults(
					{ "toolset-state:x": { enabled: true } },
					"project",
				),
			).toThrow(/malformed settings.json/);

			// File unchanged
			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("W6a2: writeToolsetDefaults throws MalformedSettingsError on non-object (array)", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "[]");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() =>
				writeToolsetDefaults(
					{ "toolset-state:x": { enabled: true } },
					"project",
				),
			).toThrow(MalformedSettingsError);

			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("W6a3: writeToolsetDefaults throws on non-object (null)", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "null");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() =>
				writeToolsetDefaults(
					{ "toolset-state:x": { enabled: true } },
					"project",
				),
			).toThrow(/non-object settings.json/);

			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("W6b: clearToolsetDefaults throws on malformed JSON", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "{not valid");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() => clearToolsetDefaults("project")).toThrow(
				/malformed settings.json/,
			);

			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("W6b2: clearToolsetDefaults throws on non-object (array)", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "[]");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() => clearToolsetDefaults("project")).toThrow(
				/non-object settings.json/,
			);

			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("W6b3: clearToolsetDefaults returns null for missing file", () => {
			// No .pi/settings.json written — file doesn't exist
			expect(clearToolsetDefaults("project")).toBeNull();
		});
	});

	// W7 — top-level-key preservation (disk)
	describe("W7: top-level-key preservation (disk)", () => {
		let tmpDir: string;
		let origCwd: string;

		beforeEach(() => {
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests(null);

			tmpDir = mkdtempSync(join(tmpdir(), "pi-tool-masking-writer-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });
			origCwd = process.cwd();
			process.chdir(tmpDir);

			// Seed a settings file with non-toolsetDefaults keys
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify(
					{
						provider: "mistral",
						theme: "x",
						toolsetDefaults: {
							"toolset-state:old": { enabled: false },
						},
					},
					null,
					2,
				) + "\n",
			);
		});

		afterEach(() => {
			process.chdir(origCwd);
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests({});
		});

		it("W7: write preserves provider, theme, existing td entries; adds new entry", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");

			writeToolsetDefaults(
				{ "toolset-state:new": { enabled: true } },
				"project",
			);

			const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(raw.provider).toBe("mistral");
			expect(raw.theme).toBe("x");
			expect(raw.toolsetDefaults["toolset-state:old"]).toEqual({
				enabled: false,
			});
			expect(raw.toolsetDefaults["toolset-state:new"]).toEqual({
				enabled: true,
			});
		});

		it("W7b: clearToolsetDefaults removes the wrapper key, preserves other keys", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");

			const result = clearToolsetDefaults("project");
			expect(result).toBe(settingsPath);

			const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(raw.provider).toBe("mistral");
			expect(raw.theme).toBe("x");
			expect(raw.toolsetDefaults).toBeUndefined();
		});

		it("W7c: clearToolsetDefaults returns null when no toolsetDefaults key", () => {
			// Remove the key first
			clearToolsetDefaults("project");
			expect(clearToolsetDefaults("project")).toBeNull();

			// Other keys still intact
			const raw = JSON.parse(
				readFileSync(join(tmpDir, ".pi", "settings.json"), "utf-8"),
			);
			expect(raw.provider).toBe("mistral");
		});
	});

	// W8 — no-op writes skip disk reformat (don't rewrite a hand-edited file
	// when the values are already what's being written). Observable: the
	// writer serializes with JSON.stringify(_, null, 2), so a skip preserves
	// our compact seed bytes while a real write would reformat to indented.
	describe("W8: no-op writes skip disk reformat", () => {
		let tmpDir: string;
		let origCwd: string;

		beforeEach(() => {
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests(null);

			tmpDir = mkdtempSync(join(tmpdir(), "pi-tool-masking-writer-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });
			origCwd = process.cwd();
			process.chdir(tmpDir);
		});

		afterEach(() => {
			process.chdir(origCwd);
			setSettingsWriterOverrideForTests(null);
			setSettingsOverrideForTests({});
		});

		it("W8a: writeToolsetDefaults with unchanged values does not rewrite", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			// Compact seed (writer would emit 2-space indented + trailing \n)
			const seed = '{"toolsetDefaults":{"toolset-state:x":{"enabled":true}}}';
			writeFileSync(settingsPath, seed);

			writeToolsetDefaults({ "toolset-state:x": { enabled: true } }, "project");

			expect(readFileSync(settingsPath, "utf-8")).toBe(seed);
		});

		it("W8b: writeToolsetDefaults with {} entries does not rewrite", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			const seed = '{"toolsetDefaults":{"toolset-state:x":{"enabled":true}}}';
			writeFileSync(settingsPath, seed);

			writeToolsetDefaults({}, "project");

			expect(readFileSync(settingsPath, "utf-8")).toBe(seed);
		});

		it("W8d: a real change still rewrites (sanity for W8a observable)", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			const seed = '{"toolsetDefaults":{"toolset-state:x":{"enabled":true}}}';
			writeFileSync(settingsPath, seed);

			writeToolsetDefaults(
				{ "toolset-state:x": { enabled: false } },
				"project",
			);

			// A real change must reformat — proves the compact-seed observable
			// actually detects writes (else W8a would pass for the wrong reason)
			expect(readFileSync(settingsPath, "utf-8")).not.toBe(seed);
			const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(raw.toolsetDefaults["toolset-state:x"]).toEqual({
				enabled: false,
			});
		});
	});
});

// ===================================================================
// Restore — settings.json defaults tier
// ===================================================================

describe("Restore — settings.json defaults tier", () => {
	it("S1: settings default on fresh session — settings false beats spec.defaultEnabled true", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setSettingsOverrideForTests({
			"toolset-state:test.toolset": { enabled: false },
		});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("S2: chat-branch entry beats settings default (tier 1 > tier 2)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });
		setSettingsOverrideForTests({
			"toolset-state:test.toolset": { enabled: false },
		});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("tool-a");
	});

	it("S3: settings absent → packaged default (tier 3 unchanged)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setSettingsOverrideForTests({});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("S4: settings honored in inclusion mode — pinned true restores on", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setSettingsOverrideForTests({
			"toolset-state:test.toolset": { enabled: true },
		});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		setDefaultResolutionMode(pi, "inclusion");
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("tool-a");
	});

	it("S5: settings pinned false in inclusion stays off", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setSettingsOverrideForTests({
			"toolset-state:test.toolset": { enabled: false },
		});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		setDefaultResolutionMode(pi, "inclusion");
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("S6: unpinned in inclusion falls to false regardless of defaultEnabled", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setSettingsOverrideForTests({});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		setDefaultResolutionMode(pi, "inclusion");
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("S7: null-tombstoned branch entry falls through to settings pin", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setSettingsOverrideForTests({
			"toolset-state:test.toolset": { enabled: false },
		});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		// real entry (true), then null tombstone → settings pin (false) wins
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });
		mock.appendEntry("toolset-state:test.toolset", null);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});
});

// ===================================================================
// getEffectiveDefault
// ===================================================================

describe("getEffectiveDefault", () => {
	it("G1: snapshot overrides spec.defaultEnabled", () => {
		const spec = makeSpec({ defaultEnabled: true });
		const snapshot = { "toolset-state:test.toolset": { enabled: false } };
		expect(getEffectiveDefault(spec, snapshot)).toBe(false);
	});

	it("G2: falls back to spec.defaultEnabled ?? true", () => {
		const spec = makeSpec({ defaultEnabled: false });
		expect(getEffectiveDefault(spec, {})).toBe(false);

		const specNoDefault = makeSpec(); // defaultEnabled undefined
		expect(getEffectiveDefault(specNoDefault, {})).toBe(true);
	});

	it("G3: reads disk when no snapshot passed", () => {
		setSettingsOverrideForTests({
			"toolset-state:test.toolset": { enabled: false },
		});
		try {
			const spec = makeSpec({ defaultEnabled: true });
			expect(getEffectiveDefault(spec)).toBe(false);
		} finally {
			setSettingsOverrideForTests({});
		}
	});
});

// ===================================================================
// Null-tombstone — toolset restore
// ===================================================================

describe("Null-tombstone — toolset restore", () => {
	it("AT1: null tombstone after real entry falls through to settings/packaged", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);

		// Branch: real entry then null tombstone
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });
		mock.appendEntry("toolset-state:test.toolset", null);

		mock.fireLifecycleEvent("session_start");

		// Falls through to packaged default (false), not the stale true entry
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("AT2: real entry without tombstone restores true (regression guard)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);

		mock.appendEntry("toolset-state:test.toolset", { enabled: true });

		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toContain("tool-a");
	});

	it("AT3: only a null tombstone (no prior real entry) falls through", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);

		mock.appendEntry("toolset-state:test.toolset", null);

		mock.fireLifecycleEvent("session_start");

		// No real entry → packaged default (true)
		expect(mock.getActiveTools()).toContain("tool-a");
	});

	it("AT4: live toggle after tombstone supersedes it (last-writer-wins)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);

		// Tombstone, then live toggle (enabled)
		mock.appendEntry("toolset-state:test.toolset", null);
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });

		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toContain("tool-a");
	});

	it("AT5: malformed last entry (no enabled field) falls through", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);

		// Malformed entry: has data but no `enabled` field
		mock.appendEntry("toolset-state:test.toolset", { foo: "bar" });

		mock.fireLifecycleEvent("session_start");

		// Falls through to packaged default (false), not silently unrestored
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("AT6: companion-mirror write across a tombstone in the same pass is visible", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "base-tool", description: "" });
		mock.registerTool({ name: "comp-tool", description: "" });

		// Base defaults OFF with a tombstoned stale {enabled:true} entry; comp
		// defaults ON. The tombstone makes base fall through to its packaged
		// default (off) — emitting `changed` (fallback path, not `restored`) —
		// and the mirror's synchronous disable of comp must be visible to
		// comp's own restore later in the same pass (branch re-read per
		// toolset, same mechanism as the companion-mirror test but across a tombstone).
		const baseSpec = makeSpec({
			id: "base",
			persistKey: "k:base",
			names: new Set(["base-tool"]),
			defaultEnabled: false,
		});
		const compSpec = makeSpec({
			id: "comp",
			persistKey: "k:comp",
			names: new Set(["comp-tool"]),
			defaultEnabled: true,
		});
		defineToolset(pi, baseSpec);
		const comp = defineToolset(pi, compSpec);

		pi.events.on(TOOLSET_EVENTS.changed, (data: any) => {
			if (data.id === "base") {
				if (data.enabled) comp.enable(pi);
				else comp.disable(pi);
			}
		});

		// Real entry then null tombstone — the tombstone must beat the stale
		// {enabled:true} and fall through, not restore true.
		mock.appendEntry("k:base", { enabled: true });
		mock.appendEntry("k:base", null);

		mock.setActiveTools(["base-tool", "comp-tool"]);
		mock.fireLifecycleEvent("session_start");

		// Base off (tombstone fell through to packaged default), comp off —
		// comp's own restore saw the mirror-written {enabled:false}, not its
		// packaged default true.
		expect(mock.getActiveTools()).not.toContain("base-tool");
		expect(mock.getActiveTools()).not.toContain("comp-tool");
		const compEntries = mock
			.getEntries("k:comp")
			.map((e) => (e.data as any)?.enabled);
		expect(compEntries).toContain(false);
	});
});

// ===================================================================
// Tombstone helpers
// ===================================================================

describe("Tombstone helpers", () => {
	const branchOf = (mock: MockPI) =>
		mock.createContext().sessionManager.getBranch();

	it("BT1: clearToolsetEntry appends null when last entry is non-null", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });

		clearToolsetEntry(pi, "toolset-state:test.toolset", branchOf(mock));

		const entries = mock.getEntries("toolset-state:test.toolset");
		expect(entries).toHaveLength(2);
		expect(entries[1]!.data).toBeNull();
	});

	it("BT2: clearToolsetEntry no-ops when last entry already cleared", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });
		mock.appendEntry("toolset-state:test.toolset", null);

		clearToolsetEntry(pi, "toolset-state:test.toolset", branchOf(mock));

		// No second tombstone stacked
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(2);
	});

	it("BT3: clearToolsetEntry no-ops when key has no prior entry", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));

		clearToolsetEntry(pi, "toolset-state:test.toolset", branchOf(mock));

		// No redundant tombstone for a never-toggled toolset
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(0);
	});

	it("BT4: clearAllToolsetEntries tombstones only toolsets with prior entries", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "a",
				persistKey: "toolset-state:a",
				names: new Set(["tool-a"]),
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "b",
				persistKey: "toolset-state:b",
				names: new Set(["tool-b"]),
			}),
		);
		mock.appendEntry("toolset-state:a", { enabled: true });
		// toolset b never toggled → no branch entry

		clearAllToolsetEntries(pi, branchOf(mock));

		const a = mock.getEntries("toolset-state:a");
		expect(a).toHaveLength(2);
		expect(a[1]!.data).toBeNull();
		expect(mock.getEntries("toolset-state:b")).toHaveLength(0);
	});

	it("BT5: consecutive clearAllToolsetEntries write zero new tombstones", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });

		clearAllToolsetEntries(pi, branchOf(mock));
		clearAllToolsetEntries(pi, branchOf(mock));

		// First call appends the tombstone; second sees it and skips
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(2);
	});

	it("BT6: tombstone then restore falls through to settings pin", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		setSettingsOverrideForTests({
			"toolset-state:test.toolset": { enabled: false },
		});
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });

		clearToolsetEntry(pi, "toolset-state:test.toolset", branchOf(mock));
		mock.fireLifecycleEvent("session_start");

		// Tombstone makes the stale {enabled:true} invisible; settings pin wins
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});
});

// ===================================================================
// applyToolsetEnabled
// ===================================================================

describe("applyToolsetEnabled", () => {
	it("E1: applies state and emits changed, no appendEntry", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const spec = makeSpec({ names: new Set(["tool-a"]) });
		defineToolset(pi, spec);

		const changed: { id: string; enabled: boolean }[] = [];
		const restored: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));
		mock.events.on(TOOLSET_EVENTS.restored, (data: any) => restored.push(data));

		applyToolsetEnabled(pi, spec, true);

		expect(mock.getActiveTools()).toContain("tool-a");
		expect(changed).toEqual([{ id: "test.toolset", enabled: true }]);
		expect(restored).toHaveLength(0);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(0);
	});

	it("E2: applyToolsetEnabled(false) deactivates without persisting", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.setActiveTools(["tool-a"]);
		const spec = makeSpec({ names: new Set(["tool-a"]) });
		defineToolset(pi, spec);

		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		applyToolsetEnabled(pi, spec, false);

		expect(mock.getActiveTools()).not.toContain("tool-a");
		expect(changed).toEqual([{ id: "test.toolset", enabled: false }]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(0);
	});

	it("E3: emits member fanout when emitMemberEvents is set", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const spec = makeSpec({
			names: new Set(["tool-a"]),
			emitMemberEvents: true,
		});
		defineToolset(pi, spec);

		const changed: any[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		applyToolsetEnabled(pi, spec, true);

		expect(changed).toEqual([
			{ id: "test.toolset", enabled: true },
			{ id: "test.toolset", enabled: true, member: "tool-a" },
		]);
	});
});
