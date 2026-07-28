import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi } from "vitest";
import { MockPI } from "./mock-pi.js";
import {
	defineToolset,
	TOOLSET_EVENTS,
	setDefaultResolutionMode,
	getDefaultResolutionMode,
	getRegisteredToolsets,
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

function cleanRegistry(): void {
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[RESTORE_EVENT_KEY];
	delete (globalThis as any)[MODULE_STATE_KEY];
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
});

// ===================================================================
// §6.1 Registry
// ===================================================================

describe("Registry (§6.1)", () => {
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

	// §10.1 / §6 — companion mirror during restore must stay consistent.
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

		// Companion co-activation: mirror base `changed` only (§10.1).
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
// Toolset.enable (§9, §4.1)
// ===================================================================

describe("Toolset.enable (§9, §4.1)", () => {
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
// Toolset.disable (§9)
// ===================================================================

describe("Toolset.disable (§9)", () => {
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
// §9 invariant: disable reads from getActiveTools, not getAllTools
// ===================================================================

describe("§9 invariant — disable reads getActiveTools, not getAllTools", () => {
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
// Toolset with empty names (§9)
// ===================================================================

describe("Toolset with empty names (§9)", () => {
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
// Peer composition (§9 canonical test)
// ===================================================================

describe("Peer composition (§9 canonical test)", () => {
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
// getRegisteredToolsets (§5)
// ===================================================================

describe("getRegisteredToolsets (§5)", () => {
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
// Default resolution mode (§4.5)
// ===================================================================

describe("Default resolution mode (§4.5)", () => {
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
			'[pi-tool-masking] Invalid defaultResolutionMode: "invalid". Must be "exclusion" or "inclusion".',
		);
	});
});

// ===================================================================
// Resolution mode persistence — survives quit/resume (§4.5, §13.2)
// ===================================================================

describe("Resolution mode persistence — survives quit/resume (§4.5, §13.2)", () => {
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
// Dependency cascade on enable (§9, §4.4)
// ===================================================================

describe("Dependency cascade on enable (§9, §4.4)", () => {
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
// Cascade appendEntry consistency (§4.4)
// ===================================================================

describe("Cascade appendEntry consistency (§4.4)", () => {
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
// Cycle detection on enable (§4.4)
// ===================================================================

describe("Cycle detection on enable (§4.4)", () => {
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
// Forward references (§4.4)
// ===================================================================

describe("Forward references (§4.4)", () => {
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
// Reverse cascade on disable (§4.4, §9)
// ===================================================================

describe("Reverse cascade on disable (§4.4, §9)", () => {
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
// Cycle detection on disable (§4.4)
// ===================================================================

describe("Cycle detection on disable (§4.4)", () => {
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
// Restore — persistence round-trip (§6, §12)
// ===================================================================

describe("Restore — persistence round-trip (§6, §12)", () => {
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
// Restore — no entry (default fallback, §6, §7.1)
// ===================================================================

describe("Restore — no entry (default fallback, §6, §7.1)", () => {
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
// Restore — always-emit invariant (§6)
// ===================================================================

describe("Restore — always-emit invariant (§6)", () => {
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
// Restore — event split changed vs restored (§6)
// ===================================================================

describe("Restore — event split changed vs restored (§6)", () => {
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
// emitMemberEvents (§6, §13)
// ===================================================================

describe("emitMemberEvents (§6, §13)", () => {
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
// Restore — idempotent / last-writer-wins (§6)
// ===================================================================

describe("Restore — idempotent / last-writer-wins (§6)", () => {
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
// Restore — session_tree (§6)
// ===================================================================

describe("Restore — session_tree (§6)", () => {
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
// Restore independence with requires (§7.1)
// ===================================================================

describe("Restore independence — does not cascade (§7.1)", () => {
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
// Default-resolution mode — entry vs no-entry (§4.5)
// ===================================================================

describe("Default-resolution mode — entry vs no-entry (§4.5)", () => {
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
// Entry-point exports (§5)
// ===================================================================

describe("Entry-point exports (§5)", () => {
	it("all public exports resolve from the package entry", () => {
		expect(typeof defineToolset).toBe("function");
		expect(typeof setDefaultResolutionMode).toBe("function");
		expect(typeof getDefaultResolutionMode).toBe("function");

		expect(typeof TOOLSET_EVENTS).toBe("object");
		expect(typeof TOOLSET_EVENTS.changed).toBe("string");
		expect(typeof TOOLSET_EVENTS.restored).toBe("string");
	});
});
