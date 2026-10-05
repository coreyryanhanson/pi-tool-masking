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
	getRegisteredToolsets,
	parseToolsetDefaults,
	readMergedToolsetDefaults,
	readToolsetDefaults,
	getEffectiveDefault,
	effectiveEnabled,
	setSettingsOverrideForTests,
	setSettingsWriterOverrideForTests,
	writeToolsetDefaults,
	clearToolsetDefaults,
	MalformedSettingsError,
	clearToolsetEntry,
	clearAllToolsetEntries,
	forceToolsetEnabled,
	AllowlistModeError,
	planBatch,
	executeBatchPlan,
	toggleBatch,
	readBranchModeState,
	type BatchOp,
	type RegistryEntry,
} from "../index.js";
import { cleanRegistry, REGISTRY_KEY, catchByName, createEnv, reader } from "./helpers.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Local wrapper keeping the historical flat defaults shape at call sites:
 * wraps the map into the per-scope seam shape
 * (`{ global: { toolsetDefaults }, project: {} }`). `null` passes through
 * (seam off).
 */
function setDefaultsOverride(
	defaults: Record<string, { enabled: boolean }> | null,
): void {
	setSettingsOverrideForTests(
		defaults === null
			? null
			: { global: { toolsetDefaults: defaults }, project: {} },
	);
}

/** Executor-level plumbing shared by planner/executor describe blocks:
 *  one branch read + one settings snapshot per call, then plan → execute. */
function execute(mock: MockPI, ops: BatchOp[]) {
	const branch = mock.branchReader().getBranch();
	return executeBatchPlan(
		planBatch(ops),
		mock as unknown as ExtensionAPI,
		branch,
		readMergedToolsetDefaults(),
	);
}

function makeSpec(
	overrides: Partial<{
		id: string;
		persistKey: string;
		names: Set<string>;
		defaultEnabled: boolean;
		requires: string[];
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
	setDefaultsOverride({});
});

afterEach(() => {
	setDefaultsOverride(null);
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

	it("throws on the reserved resolution-mode persistKey", () => {
		const { pi } = createEnv();
		expect(() =>
			defineToolset(pi, makeSpec({ persistKey: "toolset-resolution-mode" })),
		).toThrow("is reserved for the resolution-mode branch entry");
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

	it("registers handlers once per pi — N toolsets, one run per event", () => {
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
		// Registration is deduped per pi (WeakSet guard), so N toolsets sharing
		// one pi install ONE handler set — O(toolsets) per turn, not O(N·toolsets).
		expect(mock.handlerCount("session_start")).toBe(1);
		expect(mock.handlerCount("session_tree")).toBe(1);
		expect(mock.handlerCount("before_agent_start")).toBe(1);
		// Single run still emits exactly one event per toolset
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
				if (data.enabled) comp.enable(pi, reader(pi));
				else comp.disable(pi, reader(pi));
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
				if (data.enabled) comp.enable(pi1, reader(pi1));
				else comp.disable(pi1, reader(pi1));
			}
		});
		// Real pi activates every extension tool at startup before restore.
		s1.setActiveTools(["base-tool", "comp-tool"]);
		s1.fireLifecycleEvent("session_start"); // base off → mirror disables comp
		base.enable(pi1, reader(pi1)); // base on → mirror enables comp

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

	it("throws PersistKeyCollisionError on duplicate persistKey across different ids", () => {
		const { pi } = createEnv();
		defineToolset(pi, makeSpec({ id: "a", persistKey: "shared-key" }));
		try {
			defineToolset(pi, makeSpec({ id: "b", persistKey: "shared-key" }));
			expect.unreachable("defineToolset should have thrown");
		} catch (err) {
			// Name-based, not instanceof — same contract as the toggle refusals.
			expect((err as { name?: string })?.name).toBe("PersistKeyCollisionError");
			expect((err as { persistKey?: string }).persistKey).toBe("shared-key");
			expect((err as { existingId?: string }).existingId).toBe("a");
		}
	});

	it("replace on changed spec does not throw on own unchanged persistKey (self-skip)", () => {
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
		// Re-define "a" with a changed spec whose persistKey is unchanged — the
		// collision loop skips the spec's own id.
		expect(() =>
			defineToolset(
				pi,
				makeSpec({
					id: "a",
					persistKey: "toolset-state:a",
					names: new Set(["x", "y"]),
				}),
			),
		).not.toThrow();
		warnSpy.mockRestore();
	});

	it("replace on changed spec whose new persistKey collides throws PersistKeyCollisionError", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi } = createEnv();
		defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["x"]) }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "b", persistKey: "k:b", names: new Set(["y"]) }),
		);
		// Re-define "a" with a changed spec that now claims b's persistKey —
		// the self-skip only protects the spec's own key, not a foreign one.
		try {
			defineToolset(
				pi,
				makeSpec({ id: "a", persistKey: "k:b", names: new Set(["x2"]) }),
			);
			expect.unreachable("defineToolset should have thrown");
		} catch (err) {
			expect((err as { name?: string })?.name).toBe("PersistKeyCollisionError");
			expect((err as { persistKey?: string }).persistKey).toBe("k:b");
			expect((err as { existingId?: string }).existingId).toBe("b");
		}
		warnSpy.mockRestore();
	});

	it("allows duplicate id with identical spec (idempotent re-registration)", () => {
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
		ts.enable(pi, reader(pi));
		expect(mock.getActiveTools()).toEqual(
			expect.arrayContaining(["tool-a", "tool-b"]),
		);
		const entries = mock.getEntries("toolset-state:test.toolset");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.data).toEqual({ enabled: true });
		expect(ts.isEnabled(pi)).toBe(true);
	});

	it("is additive — keeps existing active tools", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		mock.registerTool({ name: "tool-c", description: "" });
		mock.setActiveTools(["tool-c"]);
		const ts = defineToolset(pi, makeSpec());
		ts.enable(pi, reader(pi));
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
		ts.enable(pi, reader(pi));
		expect(mock.getActiveTools()).toContain("tool-a");
		expect(mock.getActiveTools()).not.toContain("does-not-exist");
	});

	it("emits changed event with enabled: true", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		const emitSpy = vi.spyOn(mock.events, "emit");
		const ts = defineToolset(pi, makeSpec());
		ts.enable(pi, reader(pi));
		expect(emitSpy).toHaveBeenCalledWith(TOOLSET_EVENTS.changed, {
			id: "test.toolset",
			enabled: true,
		});
		// Toggles emit `changed`, never `restored` (branch replay only).
		expect(
			emitSpy.mock.calls.filter(([c]) => c === TOOLSET_EVENTS.restored),
		).toHaveLength(0);
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
		ts.enable(pi, reader(pi));
		ts.disable(pi, reader(pi));
		expect(mock.getActiveTools()).not.toContain("tool-a");
		expect(mock.getActiveTools()).not.toContain("tool-b");
		const disableEntries = mock.getEntries("toolset-state:test.toolset");
		const last = disableEntries[disableEntries.length - 1];
		expect(last?.data).toEqual({ enabled: false });
	});

	it("emits changed event with enabled: false", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi));
		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.disable(pi, reader(pi));
		expect(emitSpy).toHaveBeenCalledWith(TOOLSET_EVENTS.changed, {
			id: "test.toolset",
			enabled: false,
		});
		// Toggles emit `changed`, never `restored` (branch replay only).
		expect(
			emitSpy.mock.calls.filter(([c]) => c === TOOLSET_EVENTS.restored),
		).toHaveLength(0);
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
		expect(() => ts.enable(pi, reader(pi))).not.toThrow();
		expect(mock.getEntries().length).toBe(0);
	});

	it("disable persists the off entry (toggle opposing the resolved default) and does not throw", () => {
		const { mock, pi } = createEnv();
		const ts = defineToolset(pi, makeSpec({ names: new Set([]) }));
		expect(() => ts.disable(pi, reader(pi))).not.toThrow();
		// Delta gate: an empty-names toggle opposing the resolved default
		// (defaultEnabled ?? true) persists — the old vacuous-witness no-op is
		// gone.
		expect(mock.getEntries().length).toBe(1);
	});

	it("isEnabled returns false", () => {
		const { pi } = createEnv();
		const ts = defineToolset(pi, makeSpec({ names: new Set([]) }));
		expect(ts.isEnabled(pi)).toBe(false);
	});
});

// ===================================================================
// Peer composition (canonical test) — disable reads getActiveTools,
// not getAllTools: a disabled toolset's members must never be revived.
// ===================================================================

describe("Peer composition — disable reads getActiveTools, not getAllTools", () => {
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
		tsA.enable(pi, reader(pi));
		tsB.enable(pi, reader(pi));
		expect(mock.getActiveTools()).toEqual(
			expect.arrayContaining(["a-only", "b-only"]),
		);
		tsA.disable(pi, reader(pi));
		expect(mock.getActiveTools()).not.toContain("a-only");
		expect(mock.getActiveTools()).toContain("b-only");
		tsB.disable(pi, reader(pi));
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
		tsA.enable(pi, reader(pi));
		tsB.enable(pi, reader(pi));
		tsC.enable(pi, reader(pi));
		tsB.disable(pi, reader(pi));
		expect(mock.getActiveTools()).toContain("a-tool");
		expect(mock.getActiveTools()).not.toContain("b-tool");
		expect(mock.getActiveTools()).toContain("c-tool");
		tsC.disable(pi, reader(pi));
		expect(mock.getActiveTools()).not.toContain("c-tool");
		tsA.disable(pi, reader(pi));
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

});

// ===================================================================
// Default resolution mode
// ===================================================================

describe("Default resolution mode", () => {
	it("empty branch resolves to exclusion (absent mode entry fails open to the ledger)", () => {
		const { pi } = createEnv();
		expect(readBranchModeState(reader(pi).getBranch()).mode).toBe("exclusion");
	});

	it("mode persists across successive setDefaultResolutionMode calls (last entry wins)", () => {
		const { pi } = createEnv();
		setDefaultResolutionMode(pi, "allowlist", ["some.web"]);
		expect(readBranchModeState(reader(pi).getBranch()).mode).toBe("allowlist");
		setDefaultResolutionMode(pi, "exclusion");
		expect(readBranchModeState(reader(pi).getBranch()).mode).toBe("exclusion");
	});

	it("setDefaultResolutionMode appends a durable mode entry", () => {
		const { mock, pi } = createEnv();
		setDefaultResolutionMode(pi, "exclusion");
		const entries = mock.getEntries("toolset-resolution-mode");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.data).toEqual({ mode: "exclusion" });
	});

	it("throws for invalid mode", () => {
		const { pi } = createEnv();
		expect(() => (setDefaultResolutionMode as any)(pi, "invalid")).toThrow(
			'[pi-tool-masking] Invalid defaultResolutionMode: "invalid". Must be "exclusion" or "allowlist".',
		);
	});
});
// ===================================================================
// Allowlist resolution mode
// ===================================================================

describe("Allowlist resolution mode", () => {
	it("setDefaultResolutionMode persists the array to the branch", () => {
		const { mock, pi } = createEnv();
		setDefaultResolutionMode(pi, "allowlist", [
			"my-plugin.web",
			"my-plugin.learn",
		]);

		expect(readBranchModeState(reader(pi).getBranch())).toEqual({
			mode: "allowlist",
			allowlist: ["my-plugin.web", "my-plugin.learn"],
		});
		const entries = mock.getEntries("toolset-resolution-mode");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.data).toEqual({
			mode: "allowlist",
			allowlist: ["my-plugin.web", "my-plugin.learn"],
		});
	});

	it("restore under allowlist — members on, others off; stale branch entry and settings pin bypassed", () => {
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
		setDefaultsOverride({ "k:c": { enabled: true } });

		setDefaultResolutionMode(pi, "allowlist", ["a"]);
		// Real pi activates every extension tool at startup, THEN restore runs.
		mock.setActiveTools(["tool-a", "tool-b", "tool-c"]);

		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toEqual(["tool-a"]);
	});

	it("allowlist restore with nothing drifted skips the redundant setActiveTools write", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "a", persistKey: "k:a", names: new Set(["tool-a"]) }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "b", persistKey: "k:b", names: new Set(["tool-b"]) }),
		);

		setDefaultResolutionMode(pi, "allowlist", ["a"]);
		// Active set already matches the allowlist — restore must not rewrite it
		// (a redundant write forces pi to rebuild the system prompt).
		mock.setActiveTools(["tool-a"]);
		const callsBefore = mock.getSetActiveCalls().length;

		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toEqual(["tool-a"]);
		expect(mock.getSetActiveCalls()).toHaveLength(callsBefore);
	});

	it("non-toolset tools preserved during allowlist restore", () => {
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

	it("future-install suppression — toolset registered after allowlist is off", () => {
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
		// path consults readBranchModeState — the library has no actuation
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
		expect(readBranchModeState(reader(pi).getBranch()).allowlist).toEqual([
			"a",
		]); // b not in the array → off

		// Simulate actuation turning the new toolset on, then the next restore
		// suppresses it.
		mock.setActiveTools(["tool-a", "tool-b"]);
		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toEqual(["tool-a"]);
	});

	it("later exclusion entry supersedes the allowlist; per-toolset tiering resumes", () => {
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
		expect(readBranchModeState(reader(pi).getBranch())).toEqual({
			mode: "exclusion",
			allowlist: [],
		});

		mock.setActiveTools(["tool-a", "tool-b"]);
		mock.fireLifecycleEvent("session_start");

		// No branch entry, no settings pin → exclusion floor (`defaultEnabled ?? true`).
		expect(mock.getActiveTools()).toEqual(["tool-a", "tool-b"]);
	});

	it("validation — missing/empty allowlist throws; unregistered ids allowed", () => {
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
		expect(readBranchModeState(reader(pi).getBranch()).allowlist).toEqual([
			"not-registered",
		]);
	});

	it("changed-mirror companion never fires during allowlist restore (two-phase)", () => {
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
				if (data.enabled) comp.enable(pi, reader(pi));
				else comp.disable(pi, reader(pi));
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

	it("restore fail-closed — mode entry claims allowlist with no array → empty allowlist, everything off", () => {
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
		// ...recovered to an empty array (consistent, not "undefined")...
		expect(readBranchModeState(reader(pi).getBranch())).toEqual({
			mode: "allowlist",
			allowlist: [],
		});
		// ...and the recovery fails CLOSED: nothing is on. (Recovering to
		// "exclusion" instead would fail open — `defaultEnabled: true` would
		// have turned tool-a on.)
		expect(mock.getActiveTools()).toEqual([]);
	});

	it("corrupt allowlist members — non-string entries are dropped, string[] type holds", () => {
		const { mock, pi } = createEnv();
		// Hand-edited branch corruption: array present but holding non-strings.
		// (pi stores entry data by reference, so cast a mixed array in.)
		mock.appendEntry(
			"toolset-resolution-mode",
			{ mode: "allowlist", allowlist: ["a", 1, null] as unknown as string[] },
		);
		expect(readBranchModeState(reader(pi).getBranch())).toEqual({
			mode: "allowlist",
			allowlist: ["a"],
		});
	});

	it("restore fail-closed — allowlist present but not an array → empty allowlist, everything off", () => {
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

		expect(readBranchModeState(reader(pi).getBranch())).toEqual({
			mode: "allowlist",
			allowlist: [],
		});
		expect(mock.getActiveTools()).toEqual([]);
	});

	it("null-tombstoned mode entry supersedes a prior allowlist → exclusion, allowlist []", () => {
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
		expect(readBranchModeState(reader(pi).getBranch())).toEqual({
			mode: "exclusion",
			allowlist: [],
		});
		// Per-toolset tiering resumes: no entry, no pin → exclusion floor
		// (`defaultEnabled ?? true`).
		expect(mock.getActiveTools()).toEqual(["tool-a"]);
	});

	it("mode absent / unknown value in the last entry falls through to exclusion", () => {
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

		expect(readBranchModeState(reader(pi).getBranch()).mode).toBe("exclusion");
		expect(mock.getActiveTools()).toEqual(["tool-a"]);
	});
});

// ===================================================================
// before_agent_start allowlist re-assert
// ===================================================================

describe("before_agent_start allowlist re-assert", () => {
	it("removes a tool force-added after focus entered, emits changed, and is a no-op outside allowlist mode", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "search.web", description: "" });
		mock.registerTool({ name: "ask_user_question", description: "" });

		const search = makeSpec({
			id: "search.web",
			persistKey: "tbox.tool@search",
			names: new Set(["search.web"]),
		});
		const ask = makeSpec({
			id: "tbox.tool@npm:@juicesharp/rpiv-ask-user-question",
			persistKey: "tbox.tool@npm:@juicesharp/rpiv-ask-user-question",
			names: new Set(["ask_user_question"]),
		});
		defineToolset(pi, search);
		defineToolset(pi, ask);

		// Enter allowlist mode allowing only search.web.
		setDefaultResolutionMode(pi, "allowlist", ["search.web"]);
		// doRestore applies the allowlist: ask_user_question is removed.
		mock.fireLifecycleEvent("session_start");
		expect(pi.getActiveTools()).toEqual(["search.web"]);

		// Simulate the reconciler punching through on the next turn.
		mock.setActiveTools(["search.web", "ask_user_question"]);
		expect(pi.getActiveTools()).toHaveLength(2);

		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);

		// Fire the turn boundary — re-assert should undo the leak.
		mock.fireLifecycleEvent("before_agent_start");

		expect(pi.getActiveTools()).toEqual(["search.web"]);
		expect(changedSpy).toHaveBeenCalledTimes(1);
		expect(changedSpy).toHaveBeenCalledWith({
			id: "tbox.tool@npm:@juicesharp/rpiv-ask-user-question",
			enabled: false,
		});

		// Outside allowlist mode: re-assert is a no-op.
		setDefaultResolutionMode(pi, "exclusion");
		mock.setActiveTools(["search.web", "ask_user_question"]);
		changedSpy.mockClear();
		mock.fireLifecycleEvent("before_agent_start");
		expect(pi.getActiveTools()).toEqual(["search.web", "ask_user_question"]);
		expect(changedSpy).not.toHaveBeenCalled();
	});

	it("restores an allowlisted member force-removed mid-session, emitting changed enabled:true", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "search.web", description: "" });
		const search = makeSpec({
			id: "search.web",
			persistKey: "tbox.tool@search",
			names: new Set(["search.web"]),
		});
		defineToolset(pi, search);
		setDefaultResolutionMode(pi, "allowlist", ["search.web"]);
		mock.fireLifecycleEvent("session_start");
		expect(pi.getActiveTools()).toEqual(["search.web"]);

		// Another extension force-removes the only allowlisted member.
		mock.setActiveTools([]);
		expect(pi.getActiveTools()).toHaveLength(0);

		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);

		// Turn boundary — re-assert should restore the force-removed member.
		mock.fireLifecycleEvent("before_agent_start");

		expect(pi.getActiveTools()).toEqual(["search.web"]);
		expect(changedSpy).toHaveBeenCalledTimes(1);
		expect(changedSpy).toHaveBeenCalledWith({
			id: "search.web",
			enabled: true,
		});
	});

	it("does not emit a false restoration for allowlisted names whose tools are unregistered", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "search.web", description: "" });
		mock.registerTool({ name: "leak.tool", description: "" });
		// The allowlisted toolset also claims a forward-reference name whose
		// tool is NOT registered — it can be allowed but never restored.
		const search = makeSpec({
			id: "search.web",
			persistKey: "tbox.tool@search",
			names: new Set(["search.web", "future.web"]),
		});
		const leak = makeSpec({
			id: "leak.tool",
			persistKey: "k:leak",
			names: new Set(["leak.tool"]),
		});
		defineToolset(pi, search);
		defineToolset(pi, leak);
		setDefaultResolutionMode(pi, "allowlist", ["search.web"]);
		mock.fireLifecycleEvent("session_start");

		// Reconciler force-adds the non-allowlisted leak.
		mock.setActiveTools(["search.web", "leak.tool"]);
		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);

		mock.fireLifecycleEvent("before_agent_start");

		// Leak removed; search.web was never off, so NO enabled:true for it.
		expect(pi.getActiveTools()).toEqual(["search.web"]);
		expect(changedSpy).toHaveBeenCalledTimes(1);
		expect(changedSpy).toHaveBeenCalledWith({
			id: "leak.tool",
			enabled: false,
		});
	});

	it("is a steady-state no-op — does not emit or mutate when nothing drifted", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "search.web", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "search.web",
				persistKey: "tbox.tool@search",
				names: new Set(["search.web"]),
			}),
		);
		setDefaultResolutionMode(pi, "allowlist", ["search.web"]);
		mock.fireLifecycleEvent("session_start");
		// Steady state — no leak, no member removed.
		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);
		mock.fireLifecycleEvent("before_agent_start");
		expect(pi.getActiveTools()).toEqual(["search.web"]);
		expect(changedSpy).not.toHaveBeenCalled();
	});
});

// ===================================================================
// before_agent_start disabled-leak re-assert (exclusion)
// ===================================================================

describe("before_agent_start disabled-leak re-assert", () => {
	it("removes a disabled toolset's tool force-added mid-session, emits changed, and is a no-op when the toolset is effectively on", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "search.web", description: "" });
		mock.registerTool({ name: "ask_user_question", description: "" });

		const search = makeSpec({
			id: "search.web",
			persistKey: "tbox.tool@search",
			names: new Set(["search.web"]),
		});
		const ask = makeSpec({
			id: "tbox.tool@npm:@juicesharp/rpiv-ask-user-question",
			persistKey: "tbox.tool@npm:@juicesharp/rpiv-ask-user-question",
			names: new Set(["ask_user_question"]),
		});
		defineToolset(pi, search);
		const askTs = defineToolset(pi, ask);

		// Exclusion mode (the default). Restore brings both toolsets on, then
		// the user disables the ask toolset (writes a branch entry).
		mock.fireLifecycleEvent("session_start");
		expect(pi.getActiveTools()).toEqual(["search.web", "ask_user_question"]);
		askTs.disable(pi, reader(pi));
		expect(pi.getActiveTools()).toEqual(["search.web"]);

		// Simulate the reconciler punching through on the next turn.
		mock.setActiveTools(["search.web", "ask_user_question"]);
		expect(pi.getActiveTools()).toHaveLength(2);

		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);

		// Fire the turn boundary — re-assert should undo the leak.
		mock.fireLifecycleEvent("before_agent_start");

		expect(pi.getActiveTools()).toEqual(["search.web"]);
		expect(changedSpy).toHaveBeenCalledTimes(1);
		expect(changedSpy).toHaveBeenCalledWith({
			id: "tbox.tool@npm:@juicesharp/rpiv-ask-user-question",
			enabled: false,
		});

		// Effectively on: re-assert is a no-op — a default-on toolset is not
		// a hard constraint, so the force-added tool is NOT removed.
		askTs.enable(pi, reader(pi));
		mock.setActiveTools(["search.web", "ask_user_question"]);
		changedSpy.mockClear();
		mock.fireLifecycleEvent("before_agent_start");
		expect(pi.getActiveTools()).toEqual(["search.web", "ask_user_question"]);
		expect(changedSpy).not.toHaveBeenCalled();
	});

	it("is a steady-state no-op in exclusion mode — does not emit or mutate when nothing drifted", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		const ts = defineToolset(pi, makeSpec());
		ts.enable(pi, reader(pi));
		ts.disable(pi, reader(pi));
		expect(pi.getActiveTools()).toEqual([]);

		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);
		mock.fireLifecycleEvent("before_agent_start");

		expect(pi.getActiveTools()).toEqual([]);
		expect(changedSpy).not.toHaveBeenCalled();
	});

	it("honors each tier — a settings pin or branch entry flipping off is defended, flipping on is not", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		const ts = defineToolset(pi, makeSpec());

		// Tier 2: settings pin `enabled: false` flips the toolset off with no
		// branch entry (packaged default-on fallback would say on).
		setDefaultsOverride({
			"toolset-state:test.toolset": { enabled: false },
		});
		mock.fireLifecycleEvent("session_start");
		expect(pi.getActiveTools()).toEqual([]);

		// Reconciler force-adds the disabled toolset's tools.
		mock.setActiveTools(["tool-a", "tool-b"]);
		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);
		mock.fireLifecycleEvent("before_agent_start");
		expect(pi.getActiveTools()).toEqual([]);
		expect(changedSpy).toHaveBeenCalledTimes(1);
		expect(changedSpy).toHaveBeenCalledWith({
			id: "test.toolset",
			enabled: false,
		});

		// Tier 1 beats tier 2: an explicit branch entry `enabled: true` flips
		// it back on — effectively on, so re-assert does not force-remove.
		setDefaultsOverride({});
		ts.enable(pi, reader(pi));
		expect(pi.getActiveTools()).toEqual(["tool-a", "tool-b"]);
		changedSpy.mockClear();
		mock.fireLifecycleEvent("before_agent_start");
		expect(pi.getActiveTools()).toEqual(["tool-a", "tool-b"]);
		expect(changedSpy).not.toHaveBeenCalled();
	});

	it("does not emit changed for a disabled toolset whose tools were never active", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a1", description: "" });
		mock.registerTool({ name: "a2", description: "" });
		mock.registerTool({ name: "b1", description: "" });
		const tsA = defineToolset(
			pi,
			makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a1", "a2"]) }),
		);
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b1"]) }),
		);
		tsA.enable(pi, reader(pi));
		tsA.disable(pi, reader(pi));
		tsB.enable(pi, reader(pi));
		tsB.disable(pi, reader(pi));
		expect(pi.getActiveTools()).toEqual([]);

		// Only B's tool leaks back in; A's tools never return. The emit loop
		// must not claim A was affected (nothing of A was in the active set).
		mock.setActiveTools(["b1"]);
		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);
		mock.fireLifecycleEvent("before_agent_start");

		expect(pi.getActiveTools()).toEqual([]);
		expect(changedSpy).toHaveBeenCalledTimes(1);
		expect(changedSpy).toHaveBeenCalledWith({ id: "B", enabled: false });
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
		tsL.enable(pi, reader(pi));
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
		tsL.enable(pi, reader(pi));
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(tsL.isEnabled(pi)).toBe(true);
		tsB.disable(pi, reader(pi));
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
		tsB.enable(pi, reader(pi));
		expect(tsB.isEnabled(pi)).toBe(true);
		tsB.disable(pi, reader(pi));
		expect(tsB.isEnabled(pi)).toBe(false);
		tsL.enable(pi, reader(pi));
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
		tsL.enable(pi, reader(pi));
		expect(tsB.isEnabled(pi)).toBe(true);
		// Directly remove B's tool (simulates external interference)
		const withoutB = mock.getActiveTools().filter((n: string) => n !== "b-tool");
		mock.setActiveTools(withoutB);
		expect(tsB.isEnabled(pi)).toBe(false);
		expect(tsL.isEnabled(pi)).toBe(true);
		// Re-enable L restores the invariant
		tsL.enable(pi, reader(pi));
		expect(tsB.isEnabled(pi)).toBe(true);
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
		tsL.enable(pi, reader(pi));
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
		tsL.enable(pi, reader(pi));
		expect(mock.getEntries("k:L")).toHaveLength(1);
		expect(mock.getEntries("k:B")).toHaveLength(1);
		expect(mock.getEntries("k:B")[0]?.data).toEqual({ enabled: true });
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
		tsL.enable(pi, reader(pi));
		tsB.disable(pi, reader(pi));
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
		const err = catchByName(() => tsA.enable(pi, reader(pi)));
		expect(err.name).toBe("CycleError");
		// The discovered path is carried as a field, not just in the message.
		expect((err as { cyclePath?: string }).cyclePath).toBe("A → B → A");
	});

	it("detects a three-node cycle (A → B → C → A) as a CycleError", () => {
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
		const err = catchByName(() => tsA.enable(pi, reader(pi)));
		// Messages are diagnostics, not contract — pin the error identity only.
		expect(err.name).toBe("CycleError");
	});

	it("cycle throw precedes all writes and emits (enable direction)", () => {
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
		let emits = 0;
		const off = pi.events.on(TOOLSET_EVENTS.changed, () => {
			emits++;
		});
		const err = catchByName(() => tsA.enable(pi, reader(pi)));
		expect(err.name).toBe("CycleError");
		// Atomic: the planner throws before any loadout write, branch entry,
		// or emit — a caught refusal means "refused, nothing changed".
		expect(mock.getEntries()).toHaveLength(0);
		expect(emits).toBe(0);
		expect(mock.getActiveTools()).toEqual([]);
		off();
	});

	it("sibling-subtree cycle leaves the clean sibling unapplied", () => {
		const { mock, pi } = createEnv();
		for (const name of ["a-tool", "b-tool", "c-tool", "d-tool"]) {
			mock.registerTool({ name, description: "" });
		}
		// A requires [B, C]; B is clean; C ↔ D cycle.
		defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
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
				id: "D",
				persistKey: "k:D",
				names: new Set(["d-tool"]),
				requires: ["C"],
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
		let emits = 0;
		const off = pi.events.on(TOOLSET_EVENTS.changed, () => {
			emits++;
		});
		const err = catchByName(() => tsA.enable(pi, reader(pi)));
		expect(err.name).toBe("CycleError");
		// B's subtree did NOT apply — the plan threw before any execution.
		expect(mock.getEntries()).toHaveLength(0);
		expect(emits).toBe(0);
		expect(mock.getActiveTools()).toEqual([]);
		off();
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
		expect(() => tsA.enable(pi, reader(pi))).not.toThrow();
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
		expect(() => tsA.enable(pi, reader(pi))).toThrow("Cycle detected");
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
		expect(() => tsA.enable(pi, reader(pi))).not.toThrow();
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
		tsA.enable(pi, reader(pi));
		expect(mock.getActiveTools()).toEqual(["a-tool"]);
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		expect(tsB.isEnabled(pi)).toBe(false);
		tsA.enable(pi, reader(pi));
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
		tsA.enable(pi, reader(pi));
		expect(tsA.isEnabled(pi)).toBe(true);
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(tsC.isEnabled(pi)).toBe(true);
		tsB.disable(pi, reader(pi));
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
		tsL.enable(pi, reader(pi));
		tsB.disable(pi, reader(pi));
		const entryCount = mock.getEntries().length;
		const activeAfterFirst = mock.getActiveTools();
		tsB.disable(pi, reader(pi));
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
		tsX.enable(pi, reader(pi));
		expect(tsX.isEnabled(pi)).toBe(true);
		expect(tsA.isEnabled(pi)).toBe(true);
		expect(tsB.isEnabled(pi)).toBe(true);
		tsB.disable(pi, reader(pi));
		expect(tsB.isEnabled(pi)).toBe(false);
		expect(tsA.isEnabled(pi)).toBe(false);
		expect(tsX.isEnabled(pi)).toBe(false);
	});
});

// ===================================================================
// Cycle detection on disable
// ===================================================================

describe("Cycle detection on disable", () => {
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
		let emits = 0;
		const off = pi.events.on(TOOLSET_EVENTS.changed, () => {
			emits++;
		});
		const err = catchByName(() => tsA.disable(pi, reader(pi)));
		expect(err.name).toBe("CycleError");
		// Atomic in the disable direction too: the plan throws before the
		// self-apply — no branch write, no emit, no loadout write.
		expect(mock.getEntries()).toHaveLength(0);
		expect(emits).toBe(0);
		expect(mock.getActiveTools()).toEqual([]);
		off();
	});
});

// ===================================================================
// Contradiction detection (planner-level)
//
// The refusal forms are multi-op — unreachable through the single-op
// wrappers — so these pin the planner directly. The planner is pure: the
// throw precedes every write by construction, and the end-to-end no-write
// pins through a public multi-op entry point land with the batch export.
// All refusals are asserted by `err.name`, never by message text.
// ===================================================================

describe("Contradiction detection (planner-level)", () => {
	it("refuses the direct contradiction (enable X + disable Y, X requires Y)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "x-tool", description: "" });
		mock.registerTool({ name: "y-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "Y", persistKey: "k:Y", names: new Set(["y-tool"]) }),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "X",
				persistKey: "k:X",
				names: new Set(["x-tool"]),
				requires: ["Y"],
			}),
		);
		const ops: BatchOp[] = [
			{ id: "X", desired: true },
			{ id: "Y", desired: false },
		];
		const err = catchByName(() => planBatch(ops));
		expect(err.name).toBe("ContradictionError");
		// Sanity: the coherent one-op forms against the same graph still plan.
		expect(planBatch([{ id: "X", desired: true }]).intent.get("X")).toBe(true);
		expect(planBatch([{ id: "Y", desired: false }]).intent.get("Y")).toBe(false);
	});

	it("refuses the explicit-enable-over-implied-off collision (disable Y + enable X, X requires Y)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "x-tool", description: "" });
		mock.registerTool({ name: "y-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "Y", persistKey: "k:Y", names: new Set(["y-tool"]) }),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "X",
				persistKey: "k:X",
				names: new Set(["x-tool"]),
				requires: ["Y"],
			}),
		);
		// Op-order mirror of the direct form: disable Y first pulls X toward
		// off via the dependents cascade, then the explicit enable of X
		// overrides that implied value at revisit — the closure check must
		// still refuse the incoherent override ({X: true, Y: false}).
		const ops: BatchOp[] = [
			{ id: "Y", desired: false },
			{ id: "X", desired: true },
		];
		const err = catchByName(() => planBatch(ops));
		expect(err.name).toBe("ContradictionError");
	});

	it("refuses a contradiction below an intermediate enabled id", () => {
		const { mock, pi } = createEnv();
		for (const name of ["a-tool", "b-tool", "c-tool"]) {
			mock.registerTool({ name, description: "" });
		}
		defineToolset(
			pi,
			makeSpec({ id: "C", persistKey: "k:C", names: new Set(["c-tool"]) }),
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
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);
		// A → B → C: the disabled id sits two requires hops below the enabled
		// target — the check must reach through the intermediate true id.
		const ops: BatchOp[] = [
			{ id: "A", desired: true },
			{ id: "C", desired: false },
		];
		const err = catchByName(() => planBatch(ops));
		expect(err.name).toBe("ContradictionError");
	});

	it("refuses conflicting explicit duplicates on one id (zero-hop)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "x-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "X", persistKey: "k:X", names: new Set(["x-tool"]) }),
		);
		const ops: BatchOp[] = [
			{ id: "X", desired: true },
			{ id: "X", desired: false },
		];
		const err = catchByName(() => planBatch(ops));
		expect(err.name).toBe("ContradictionError");
	});

	it("refuses conflicting explicit duplicates after an implied visit (zero-hop via override)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "f-tool", description: "" });
		mock.registerTool({ name: "d-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "F", persistKey: "k:F", names: new Set(["f-tool"]) }),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "D",
				persistKey: "k:D",
				names: new Set(["d-tool"]),
				requires: ["F"],
			}),
		);
		// disable F pulls D off implied; the explicit enable and the explicit
		// disable of D then conflict — the third op's overwrite would also
		// erase the intermediate {F: false, D: true} state the coherence pass
		// catches, so the claim ledger must refuse before it can.
		const ops: BatchOp[] = [
			{ id: "F", desired: false },
			{ id: "D", desired: true },
			{ id: "D", desired: false },
		];
		const err = catchByName(() => planBatch(ops));
		expect(err.name).toBe("ContradictionError");
	});

	it("dedupes same-value duplicate ops silently", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "x-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "X", persistKey: "k:X", names: new Set(["x-tool"]) }),
		);
		const plan = planBatch([
			{ id: "X", desired: true },
			{ id: "X", desired: true },
		]);
		expect(plan.intent.get("X")).toBe(true);
		expect(plan.order).toEqual(["X"]);
	});

	it("coherent explicit-beats-implied does not throw (enable Y + disable Z, Z requires Y)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "y-tool", description: "" });
		mock.registerTool({ name: "z-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({ id: "Y", persistKey: "k:Y", names: new Set(["y-tool"]) }),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "Z",
				persistKey: "k:Z",
				names: new Set(["z-tool"]),
				requires: ["Y"],
			}),
		);
		// An off toolset imposes no requirement on its own dependencies, so
		// {Y: true, Z: false} is a legal resolution — the explicit enable of
		// Y is not clobbered by disabling its dependent.
		const plan = planBatch([
			{ id: "Y", desired: true },
			{ id: "Z", desired: false },
		]);
		expect(plan.intent.get("Y")).toBe(true);
		expect(plan.intent.get("Z")).toBe(false);
	});

	it("a disable does not drag its requirement off — the explicit enable overrides the implied-off pull (disable A + enable B, A requires B)", () => {
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
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		// Disabling A must not drag its requirement B off with it — B stays
		// explicitly on and the batch resolves {A: false, B: true}.
		const plan = planBatch([
			{ id: "A", desired: false },
			{ id: "B", desired: true },
		]);
		expect(plan.intent.get("A")).toBe(false);
		expect(plan.intent.get("B")).toBe(true);
	});
});

// ===================================================================
// ===================================================================
// Batch execution + emit-after-execution (executor-level)
// ===================================================================

describe("Batch execution (executor-level)", () => {
	/** Shared rig: C ← A (A requires C), B independent. */
	function rig() {
		const { mock, pi } = createEnv();
		for (const n of ["c-tool", "a-tool", "b-tool"]) {
			mock.registerTool({ name: n, description: "" });
		}
		defineToolset(pi, makeSpec({ id: "C", persistKey: "k:C", names: new Set(["c-tool"]) }));
		defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["C"],
			}),
		);
		defineToolset(pi, makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }));
		return { mock, pi };
	}

	it("cross-target overlap dedupes exactly-once: shared dep applied and reported once", () => {
		const { mock } = rig();
		const results = execute(mock, [
			{ id: "A", desired: true },
			{ id: "B", desired: true },
		]);
		// Discovery order [C, A, B] — C reached once despite two pullers.
		expect(results.map((r) => r.id)).toEqual(["C", "A", "B"]);
		expect(mock.getEntries("k:C")).toHaveLength(1);
		expect(mock.getActiveTools()).toEqual(
			expect.arrayContaining(["c-tool", "a-tool", "b-tool"]),
		);
	});

	it("emits fire only after ALL writes, in plan.order", () => {
		const { mock } = rig();
		const observed: { id: string; activeAtEmit: string[] }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (payload: any) => {
			observed.push({ id: payload.id, activeAtEmit: mock.getActiveTools() });
		});
		const results = execute(mock, [
			{ id: "A", desired: true },
			{ id: "B", desired: true },
		]);
		// Event order = plan.order = write/report order.
		expect(observed.map((o) => o.id)).toEqual(results.map((r) => r.id));
		// The FIRST emit already observes the final active set — no library
		// event fired mid-batch, so no listener can see an intermediate state.
		const final = mock.getActiveTools();
		for (const o of observed) {
			expect(o.activeAtEmit).toEqual(final);
		}
	});

	it("cascade emit timing: a dependency's emit fires after its dependents are written (disable)", () => {
		const { mock, pi } = createEnv();
		for (const n of ["a-tool", "b-tool", "c-tool"]) {
			mock.registerTool({ name: n, description: "" });
		}
		defineToolset(pi, makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a-tool"]) }));
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				requires: ["A"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "C",
				persistKey: "k:C",
				names: new Set(["c-tool"]),
				requires: ["A"],
			}),
		);
		// Bring everything on, then disable the root A — dependents B, C fall.
		execute(mock, [
			{ id: "A", desired: true },
			{ id: "B", desired: true },
			{ id: "C", desired: true },
		]);
		const activeAtEmit: Record<string, string[]> = {};
		mock.events.on(TOOLSET_EVENTS.changed, (payload: any) => {
			activeAtEmit[payload.id] = mock.getActiveTools();
		});
		const results = execute(mock, [{ id: "A", desired: false }]);
		// Discovery order: A self-first, then dependents in registry order.
		expect(results.map((r) => r.id)).toEqual(["A", "B", "C"]);
		// A's emit observes B and C already off — the new post-execution
		// timing (per-apply emits would have shown B, C still active).
		expect(activeAtEmit["A"]).toEqual([]);
	});

	it("the executor never re-reads the branch — the boundary's read is threaded", () => {
		const { mock, pi } = rig();
		// Public toggle path: exactly one getBranch() call per toggle, even
		// with a cascade (B's enable pulls A).
		const inner = mock.branchReader();
		let reads = 0;
		const counting = {
			getBranch: () => {
				reads++;
				return inner.getBranch();
			},
		};
		getRegisteredToolsets().find((e) => e.spec.id === "B")!.toolset.enable(
			pi,
			counting,
		);
		expect(reads).toBe(1);
	});
});

// ===================================================================
// Racing-writer residuals (pinned per plan Coverage)
// ===================================================================

describe("Racing-writer residuals", () => {
	/** Graph: A ← B (B requires A), both fresh (off). */
	function rig() {
		const { mock, pi } = createEnv();
		for (const n of ["a-tool", "b-tool"]) {
			mock.registerTool({ name: n, description: "" });
		}
		defineToolset(pi, makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a-tool"]) }));
		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				requires: ["A"],
			}),
		);
		return { mock, pi };
	}

	it("post-execution-emit listener write: emitted payload carries plan.intent; the listener's entry wins at the next restore", () => {
		const { mock } = rig();
		// A changed listener reacting to the batch's post-execution emit
		// appends "disable B" right after the batch enabled it.
		let emitted: unknown;
		mock.events.on(TOOLSET_EVENTS.changed, (payload: any) => {
			if (payload.id === "B") {
				emitted = payload;
				mock.appendEntry("k:B", { enabled: false });
			}
		});
		const results = execute(mock, [{ id: "B", desired: true }]);
		// The emitted payload carried the batch's intent (enabled: true) —
		// stale relative to the listener's later same-key write. A appears in
		// the delta as B's implied enable-closure dep.
		expect(emitted).toMatchObject({ id: "B", enabled: true });
		expect(results).toEqual([
			{ id: "A", enabled: true },
			{ id: "B", enabled: true },
		]);
		// Last-writer-wins: the listener's entry is the newest k:B entry —
		// restore honors it at the next session start (A stays on).
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("b-tool");
		expect(mock.getActiveTools()).toContain("a-tool");
	});

	it("prepareLoadout hook writes mid-batch: not repaired, not reported, wins at next restore", () => {
		const { mock } = rig();
		// A tool whose prepareLoadout hook (reached inside setActiveTools,
		// between batch writes) appends "disable A". A is written and
		// persisted BEFORE B's actuation runs the hook, so the hook's entry
		// is the newest k:A entry — the delta gate (computed pre-execution)
		// never observes it: no repair, no extra report entry.
		mock.registerTool({
			name: "b-tool",
			description: "",
			prepareLoadout: () => {
				mock.appendEntry("k:A", { enabled: false });
			},
		});
		const results = execute(mock, [{ id: "B", desired: true }]);
		// The batch's report carries plan.intent for both ids.
		expect(results).toEqual([
			{ id: "A", enabled: true },
			{ id: "B", enabled: true },
		]);
		// The hook's mid-batch entry is newest — last-writer-wins: restore
		// honors it (A off even though the batch reported A enabled: true).
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("a-tool");
		expect(mock.getActiveTools()).toContain("b-tool");
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
		ts.enable(pi, reader(pi));
		ts.disable(pi, reader(pi));
		const entries = mock.getEntries("toolset-state:test.toolset");
		const last = entries[entries.length - 1];
		expect(last?.data).toEqual({ enabled: false });
	});

	it("restore reads persisted false, applies it, emits restored", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi));
		ts.disable(pi, reader(pi));
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
		ts.enable(pi, reader(pi));
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("tool-a");
	});

	it("restore disable removes spec members, preserves non-member tools (matching actuateRemove)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		// Owned by no toolset — the library must not touch it.
		mock.registerTool({ name: "outsider", description: "" });
		const ts = defineToolset(
			pi,
			makeSpec({
				id: "two-members",
				persistKey: "k:two-members",
				names: new Set(["tool-a", "tool-b"]),
			}),
		);
		ts.enable(pi, reader(pi));
		mock.setActiveTools(["tool-a", "tool-b", "outsider"]);
		expect(mock.getActiveTools()).toEqual(["tool-a", "tool-b", "outsider"]);

		// Persist disabled and restore: spec members are removed, the rest kept.
		mock.appendEntry("k:two-members", { enabled: false });
		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toEqual(["outsider"]);
	});

	it("restore disable with nothing active skips the redundant setActiveTools write", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "two-members",
				persistKey: "k:two-members",
				names: new Set(["tool-a", "tool-b"]),
			}),
		);
		// Nothing active — the tools were never activated.
		expect(mock.getActiveTools()).toEqual([]);
		const callsBefore = mock.getSetActiveCalls().length;

		mock.appendEntry("k:two-members", { enabled: false });
		mock.fireLifecycleEvent("session_start");

		expect(mock.getActiveTools()).toEqual([]);
		// Pure-removal filter removed nothing — no loadout write.
		expect(mock.getSetActiveCalls()).toHaveLength(callsBefore);
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
});

// ===================================================================
// Restore — always-emit invariant
// ===================================================================

describe("Restore — always-emit invariant", () => {
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
// Restore — idempotent / last-writer-wins
// ===================================================================

describe("Restore — idempotent / last-writer-wins", () => {
	it("second restore on same branch produces same state", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi));
		mock.fireLifecycleEvent("session_start");
		const stateAfterFirst = [...mock.getActiveTools()];
		mock.fireLifecycleEvent("session_start");
		const stateAfterSecond = [...mock.getActiveTools()];
		expect(stateAfterSecond).toEqual(stateAfterFirst);
	});

	it("restore never persists — appendEntry is not called", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		const appendSpy = vi.spyOn(mock, "appendEntry");
		mock.fireLifecycleEvent("session_start");
		mock.fireLifecycleEvent("session_tree");
		expect(appendSpy).not.toHaveBeenCalled();
	});

	it("last-writer-wins: most recent entry takes precedence", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi));
		ts.disable(pi, reader(pi));
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});
});

// ===================================================================
// Restore — session_tree
// ===================================================================

describe("Restore — session_tree", () => {
	it("session_tree restores persisted entry and emits restored", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi));
		ts.disable(pi, reader(pi));
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
		tsB.enable(pi, reader(pi));
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
// Settings.json reader — parseToolsetDefaults
// ===================================================================

describe("parseToolsetDefaults", () => {
	it("absent toolsetDefaults returns {}", () => {
		expect(parseToolsetDefaults({})).toEqual({});
	});

	it("non-object toolsetDefaults (string, array) returns {}", () => {
		expect(parseToolsetDefaults({ toolsetDefaults: "" })).toEqual({});
		expect(parseToolsetDefaults({ toolsetDefaults: [] })).toEqual({});
	});

	it("drops entries with non-boolean enabled values (string, number)", () => {
		expect(
			parseToolsetDefaults({
				toolsetDefaults: { "k:x": { enabled: "true" }, "k:y": { enabled: 1 } },
			}),
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
// Settings.json reader — readMergedToolsetDefaults / readToolsetDefaults
// ===================================================================

describe("readMergedToolsetDefaults / readToolsetDefaults", () => {
	it("returns the override verbatim when set (global scope only)", () => {
		setDefaultsOverride({ "k:a": { enabled: false } });
		expect(readMergedToolsetDefaults()).toEqual({ "k:a": { enabled: false } });
		expect(readToolsetDefaults("global")).toEqual({
			"k:a": { enabled: false },
		});
		// Per-scope attribution: the wrapper pins only the global scope.
		expect(readToolsetDefaults("project")).toEqual({});
	});

	it("returns {} when override is empty", () => {
		setDefaultsOverride({});
		expect(readMergedToolsetDefaults()).toEqual({});
	});

	it("returns a copy, not the override object itself", () => {
		const seed = { "k:a": { enabled: true } };
		setDefaultsOverride(seed);
		const out = readMergedToolsetDefaults();
		expect(out).toEqual(seed);
		expect(out).not.toBe(seed);
	});
});

// ===================================================================
// Settings.json writer — writeToolsetDefaults / clearToolsetDefaults
// ===================================================================

describe("writeToolsetDefaults & clearToolsetDefaults", () => {
	beforeEach(() => {
		setSettingsWriterOverrideForTests({ global: {}, project: {} });
	});

	afterEach(() => {
		setSettingsWriterOverrideForTests(null);
	});

	it("writeToolsetDefaults merges entries into scope, preserves existing keys", () => {
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

	it("writing to project does not touch global, and vice versa", () => {
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

	it("clearToolsetDefaults empties scope and returns path (null when empty)", () => {
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

	it("writer override and reader override are independent", () => {
		const writerState = {
			global: { "toolset-state:writer": { enabled: true } },
			project: {},
		};
		setSettingsWriterOverrideForTests(writerState);
		setDefaultsOverride({ "toolset-state:reader": { enabled: false } });
		try {
			// Reader returns the reader override, not writer-captured state
			const merged = readMergedToolsetDefaults();
			expect(merged["toolset-state:reader"]).toEqual({ enabled: false });
			expect(merged["toolset-state:writer"]).toBeUndefined();
		} finally {
			setSettingsWriterOverrideForTests(null);
			setDefaultsOverride({});
		}
	});

	describe("disk round-trip (writeToolsetDefaults + readMergedToolsetDefaults)", () => {
		let tmpDir: string;
		let agentDir: string;
		let origCwd: string;
		let origAgentDir: string | undefined;

		beforeEach(() => {
			setSettingsWriterOverrideForTests(null);
			setDefaultsOverride(null);

			tmpDir = mkdtempSync(join(tmpdir(), "pi-tool-masking-roundtrip-"));
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
			if (origAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = origAgentDir;
			}
			setSettingsWriterOverrideForTests(null);
			setDefaultsOverride({});
		});

		it("write→readMergedToolsetDefaults round-trip (project overrides global)", () => {
			const globalPath = join(agentDir, "settings.json");
			writeFileSync(
				globalPath,
				JSON.stringify({
					toolsetDefaults: {
						"toolset-state:shared": { enabled: false },
					},
				}) + "\n",
			);

			writeToolsetDefaults({ "toolset-state:new": { enabled: true } }, "project");
			writeToolsetDefaults(
				{ "toolset-state:shared": { enabled: true } },
				"project",
			);

			const merged = readMergedToolsetDefaults();
			expect(merged["toolset-state:shared"]).toEqual({ enabled: true });
			expect(merged["toolset-state:new"]).toEqual({ enabled: true });
			expect(merged["toolset-state:missing"]).toBeUndefined();
		});

		it("readToolsetDefaults attributes to the correct scope", () => {
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
			writeToolsetDefaults({ "toolset-state:y": { enabled: false } }, "project");

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

	describe("malformed-file guard (disk)", () => {
		let tmpDir: string;
		let origCwd: string;

		beforeEach(() => {
			// Clear both overrides so reads and writes hit disk
			setSettingsWriterOverrideForTests(null);
			setDefaultsOverride(null);

			tmpDir = mkdtempSync(join(tmpdir(), "pi-tool-masking-writer-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });
			origCwd = process.cwd();
			process.chdir(tmpDir);
		});

		afterEach(() => {
			process.chdir(origCwd);
			setSettingsWriterOverrideForTests(null);
			setDefaultsOverride({});
		});

		it("writeToolsetDefaults throws on malformed JSON", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "{not valid");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() =>
				writeToolsetDefaults({ "toolset-state:x": { enabled: true } }, "project"),
			).toThrow(/malformed settings.json/);

			// File unchanged
			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("writeToolsetDefaults throws MalformedSettingsError on non-object (array)", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "[]");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() =>
				writeToolsetDefaults({ "toolset-state:x": { enabled: true } }, "project"),
			).toThrow(MalformedSettingsError);

			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("writeToolsetDefaults throws on non-object (null)", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "null");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() =>
				writeToolsetDefaults({ "toolset-state:x": { enabled: true } }, "project"),
			).toThrow(/non-object settings.json/);

			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("clearToolsetDefaults throws on malformed JSON", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "{not valid");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() => clearToolsetDefaults("project")).toThrow(
				/malformed settings.json/,
			);

			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("clearToolsetDefaults throws on non-object (array)", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			writeFileSync(settingsPath, "[]");
			const before = readFileSync(settingsPath, "utf-8");

			expect(() => clearToolsetDefaults("project")).toThrow(
				/non-object settings.json/,
			);

			expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		});

		it("clearToolsetDefaults returns null for missing file", () => {
			// No .pi/settings.json written — file doesn't exist
			expect(clearToolsetDefaults("project")).toBeNull();
		});
	});

	describe("top-level-key preservation (disk)", () => {
		let tmpDir: string;
		let origCwd: string;

		beforeEach(() => {
			setSettingsWriterOverrideForTests(null);
			setDefaultsOverride(null);

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
			setDefaultsOverride({});
		});

		it("write preserves provider, theme, existing td entries; adds new entry", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");

			writeToolsetDefaults({ "toolset-state:new": { enabled: true } }, "project");

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

		it("clearToolsetDefaults removes the wrapper key, preserves other keys", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");

			const result = clearToolsetDefaults("project");
			expect(result).toBe(settingsPath);

			const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(raw.provider).toBe("mistral");
			expect(raw.theme).toBe("x");
			expect(raw.toolsetDefaults).toBeUndefined();
		});

		it("clearToolsetDefaults returns null when no toolsetDefaults key", () => {
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

	// No-op writes skip disk reformat (don't rewrite a hand-edited file
	// when the values are already what's being written). Observable: the
	// writer serializes with JSON.stringify(_, null, 2), so a skip preserves
	// our compact seed bytes while a real write would reformat to indented.
	describe("no-op writes skip disk reformat", () => {
		let tmpDir: string;
		let origCwd: string;

		beforeEach(() => {
			setSettingsWriterOverrideForTests(null);
			setDefaultsOverride(null);

			tmpDir = mkdtempSync(join(tmpdir(), "pi-tool-masking-writer-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });
			origCwd = process.cwd();
			process.chdir(tmpDir);
		});

		afterEach(() => {
			process.chdir(origCwd);
			setSettingsWriterOverrideForTests(null);
			setDefaultsOverride({});
		});

		it("writeToolsetDefaults with unchanged values does not rewrite", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			// Compact seed (writer would emit 2-space indented + trailing \n)
			const seed = '{"toolsetDefaults":{"toolset-state:x":{"enabled":true}}}';
			writeFileSync(settingsPath, seed);

			writeToolsetDefaults({ "toolset-state:x": { enabled: true } }, "project");

			expect(readFileSync(settingsPath, "utf-8")).toBe(seed);
		});

		it("writeToolsetDefaults with {} entries does not rewrite", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			const seed = '{"toolsetDefaults":{"toolset-state:x":{"enabled":true}}}';
			writeFileSync(settingsPath, seed);

			writeToolsetDefaults({}, "project");

			expect(readFileSync(settingsPath, "utf-8")).toBe(seed);
		});

		it("a real change still rewrites (sanity for the compact-seed observable)", () => {
			const settingsPath = join(tmpDir, ".pi", "settings.json");
			const seed = '{"toolsetDefaults":{"toolset-state:x":{"enabled":true}}}';
			writeFileSync(settingsPath, seed);

			writeToolsetDefaults({ "toolset-state:x": { enabled: false } }, "project");

			// A real change must reformat — proves the compact-seed observable
			// actually detects writes (else the compact-seed check would pass
			// for the wrong reason)
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
	it("settings default on fresh session — settings false beats spec.defaultEnabled true", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setDefaultsOverride({
			"toolset-state:test.toolset": { enabled: false },
		});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("chat-branch entry beats settings default (tier 1 > tier 2)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });
		setDefaultsOverride({
			"toolset-state:test.toolset": { enabled: false },
		});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("tool-a");
	});

	it("settings absent → packaged default (tier 3 unchanged)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setDefaultsOverride({});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: false }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("settings pinned true restores on", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setDefaultsOverride({
			"toolset-state:test.toolset": { enabled: true },
		});
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		mock.fireLifecycleEvent("session_start");
		expect(mock.getActiveTools()).toContain("tool-a");
	});
});

// ===================================================================
// getEffectiveDefault
// ===================================================================

describe("getEffectiveDefault", () => {
	it("snapshot overrides spec.defaultEnabled", () => {
		const spec = makeSpec({ defaultEnabled: true });
		const snapshot = { "toolset-state:test.toolset": { enabled: false } };
		expect(getEffectiveDefault(spec, snapshot)).toBe(false);
	});

	it("falls back to spec.defaultEnabled ?? true", () => {
		const spec = makeSpec({ defaultEnabled: false });
		expect(getEffectiveDefault(spec, {})).toBe(false);

		const specNoDefault = makeSpec(); // defaultEnabled undefined
		expect(getEffectiveDefault(specNoDefault, {})).toBe(true);
	});

	it("reads disk when no snapshot passed", () => {
		setDefaultsOverride({
			"toolset-state:test.toolset": { enabled: false },
		});
		try {
			const spec = makeSpec({ defaultEnabled: true });
			expect(getEffectiveDefault(spec)).toBe(false);
		} finally {
			setDefaultsOverride({});
		}
	});
});

// ===================================================================
// Null-tombstone — toolset restore
// ===================================================================

describe("Null-tombstone — toolset restore", () => {
	it("null tombstone after real entry falls through to settings/packaged", () => {
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

	it("live toggle after tombstone supersedes it (last-writer-wins)", () => {
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

	it("malformed last entry (no enabled field) falls through", () => {
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

	it("companion-mirror write across a tombstone in the same pass is visible", () => {
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
				if (data.enabled) comp.enable(pi, reader(pi));
				else comp.disable(pi, reader(pi));
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

	it("clearToolsetEntry appends null when last entry is non-null", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });

		clearToolsetEntry(pi, "toolset-state:test.toolset", branchOf(mock));

		const entries = mock.getEntries("toolset-state:test.toolset");
		expect(entries).toHaveLength(2);
		expect(entries[1]!.data).toBeNull();
	});

	it("clearToolsetEntry no-ops when last entry already cleared", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });
		mock.appendEntry("toolset-state:test.toolset", null);

		clearToolsetEntry(pi, "toolset-state:test.toolset", branchOf(mock));

		// No second tombstone stacked
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(2);
	});

	it("clearToolsetEntry no-ops when key has no prior entry", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));

		clearToolsetEntry(pi, "toolset-state:test.toolset", branchOf(mock));

		// No redundant tombstone for a never-toggled toolset
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(0);
	});

	it("clearAllToolsetEntries tombstones only toolsets with prior entries", () => {
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

	it("consecutive clearAllToolsetEntries write zero new tombstones", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		mock.appendEntry("toolset-state:test.toolset", { enabled: true });

		clearAllToolsetEntries(pi, branchOf(mock));
		clearAllToolsetEntries(pi, branchOf(mock));

		// First call appends the tombstone; second sees it and skips
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(2);
	});

	it("tombstone then restore falls through to settings pin", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		defineToolset(
			pi,
			makeSpec({ names: new Set(["tool-a"]), defaultEnabled: true }),
		);
		setDefaultsOverride({
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
// forceToolsetEnabled
// ===================================================================

describe("forceToolsetEnabled", () => {
	it("applies state and emits changed, no appendEntry", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const spec = makeSpec({ names: new Set(["tool-a"]) });
		defineToolset(pi, spec);

		const changed: { id: string; enabled: boolean }[] = [];
		const restored: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));
		mock.events.on(TOOLSET_EVENTS.restored, (data: any) => restored.push(data));

		forceToolsetEnabled(pi, spec, true);

		expect(mock.getActiveTools()).toContain("tool-a");
		expect(changed).toEqual([{ id: "test.toolset", enabled: true }]);
		expect(restored).toHaveLength(0);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(0);
	});

	it("forceToolsetEnabled(false) deactivates without persisting", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.setActiveTools(["tool-a"]);
		const spec = makeSpec({ names: new Set(["tool-a"]) });
		defineToolset(pi, spec);

		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		forceToolsetEnabled(pi, spec, false);

		expect(mock.getActiveTools()).not.toContain("tool-a");
		expect(changed).toEqual([{ id: "test.toolset", enabled: false }]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(0);
	});
});

// ===================================================================
// hidden-exposure members
// ===================================================================

describe("hidden-exposure — mixed toolset", () => {
	it("enable declares only the actuatable member and persists intent", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "", exposure: "hidden" });
		const spec = makeSpec({ names: new Set(["tool-a", "tool-b"]) });
		const ts = defineToolset(pi, spec);

		ts.enable(pi, reader(pi));

		expect(pi.getActiveTools()).toEqual(["tool-a"]);
		expect(ts.isEnabled(pi)).toBe(true);
		const entries = mock.getEntries("toolset-state:test.toolset");
		expect(entries).toEqual([{ customType: "toolset-state:test.toolset", data: { enabled: true } }]);
	});

	it("disable removes the actuatable member and persists intent", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "tool-b", description: "", exposure: "hidden" });
		const spec = makeSpec({ names: new Set(["tool-a", "tool-b"]) });
		const ts = defineToolset(pi, spec);

		ts.enable(pi, reader(pi));
		ts.disable(pi, reader(pi));

		expect(pi.getActiveTools()).toEqual([]);
		const entries = mock.getEntries("toolset-state:test.toolset");
		expect(entries).toHaveLength(2);
		expect(entries[1]?.data).toEqual({ enabled: false });
	});
});

describe("hidden-exposure — inert toolset (intent vs observation)", () => {
	function inertEnv(overrides?: Partial<Parameters<typeof makeSpec>[0]>) {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "", exposure: "hidden" });
		const spec = makeSpec({ names: new Set(["tool-a"]), ...overrides });
		const ts = defineToolset(pi, spec);
		return { mock, pi, spec, ts };
	}

	it("enable on a default-off inert toolset persists intent and emits with zero setActiveTools calls; isEnabled stays false", () => {
		const { mock, pi, ts } = inertEnv({ defaultEnabled: false });
		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		ts.enable(pi, reader(pi));

		expect(mock.getSetActiveCalls()).toHaveLength(0);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([
			{ customType: "toolset-state:test.toolset", data: { enabled: true } },
		]);
		expect(changed).toEqual([{ id: "test.toolset", enabled: true }]);
		expect(ts.isEnabled(pi)).toBe(false);
	});

	it("enable on a default-on inert toolset is a same-value toggle — silent", () => {
		const { mock, pi, ts } = inertEnv();
		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		const results = ts.enable(pi, reader(pi));

		expect(results).toEqual([]);
		expect(mock.getSetActiveCalls()).toHaveLength(0);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([]);
		expect(changed).toEqual([]);
	});

	it("disable on the same inert toolset persists the off entry and emits, also with zero calls", () => {
		const { mock, pi, ts } = inertEnv();
		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		ts.disable(pi, reader(pi));

		expect(pi.getActiveTools()).toEqual([]);
		expect(mock.getSetActiveCalls()).toHaveLength(0);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([
			{ customType: "toolset-state:test.toolset", data: { enabled: false } },
		]);
		expect(changed).toEqual([{ id: "test.toolset", enabled: false }]);
	});

	it("after members become actuatable, the next restore actuates from the persisted entry", () => {
		const { mock, pi, ts } = inertEnv({ defaultEnabled: false });
		ts.enable(pi, reader(pi));
		expect(pi.getActiveTools()).toEqual([]);

		// MCP server connects: the same name is re-registered actuatatable
		// (real pi replaces by name on registry refresh).
		mock.registerTool({ name: "tool-a", description: "" });
		expect(mock.getAllTools()).toHaveLength(1);

		const restored: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.restored, (data: any) => restored.push(data));
		mock.fireLifecycleEvent("session_tree");

		expect(pi.getActiveTools()).toEqual(["tool-a"]);
		expect(restored).toEqual([{ id: "test.toolset", enabled: true }]);
	});

	it("persisted off on an inert toolset keeps it suppressed once members become actuatable", () => {
		const { mock, pi, ts } = inertEnv();
		ts.disable(pi, reader(pi));
		mock.registerTool({ name: "tool-a", description: "" });

		mock.fireLifecycleEvent("session_tree");

		expect(pi.getActiveTools()).toEqual([]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(1);
	});

	it("forceToolsetEnabled emits but writes no entry (inert, unchanged contract)", () => {
		const { mock, pi, spec } = inertEnv();
		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		forceToolsetEnabled(pi, spec, true);

		expect(changed).toEqual([{ id: "test.toolset", enabled: true }]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(0);
		expect(mock.getSetActiveCalls()).toHaveLength(0);
	});
});

describe("hidden-exposure — partially-connected toolset", () => {
	it("enable persists intent even though the toolset is only partially connected", () => {
		const { mock, pi } = createEnv();
		// tool-a connected, tool-b not yet (server connecting).
		mock.registerTool({ name: "tool-a", description: "" });
		const spec = makeSpec({ names: new Set(["tool-a", "tool-b"]) });
		const ts = defineToolset(pi, spec);

		ts.enable(pi, reader(pi));

		expect(pi.getActiveTools()).toEqual(["tool-a"]);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([
			{ customType: "toolset-state:test.toolset", data: { enabled: true } },
		]);
	});

	it("disable with nothing active still persists the off intent", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const spec = makeSpec({ names: new Set(["tool-a", "tool-b"]) });
		const ts = defineToolset(pi, spec);

		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));
		ts.disable(pi, reader(pi));

		// Nothing active, so no loadout write — but intent is persisted and
		// announced (the old observational gate silently dropped the "off").
		expect(pi.getActiveTools()).toEqual([]);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([
			{ customType: "toolset-state:test.toolset", data: { enabled: false } },
		]);
		expect(changed).toEqual([{ id: "test.toolset", enabled: false }]);
	});
});

describe("hidden-exposure — per-turn allowlist mask", () => {
	it("hidden member never declared; consecutive turns issue no extra calls or emits", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "search.web", description: "" });
		mock.registerTool({ name: "hidden.tool", description: "", exposure: "hidden" });
		defineToolset(
			pi,
			makeSpec({
				id: "focus.web",
				persistKey: "k:focus",
				names: new Set(["search.web", "hidden.tool"]),
			}),
		);

		setDefaultResolutionMode(pi, "allowlist", ["focus.web"]);
		mock.fireLifecycleEvent("session_start");
		expect(pi.getActiveTools()).toEqual(["search.web"]);

		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);

		const callsAfterRestore = mock.getSetActiveCalls().length;
		mock.fireLifecycleEvent("before_agent_start");
		mock.fireLifecycleEvent("before_agent_start");
		mock.fireLifecycleEvent("before_agent_start");

		// Steady state: the delta gate short-circuits — no redundant
		// setActiveTools, no spurious changed { enabled: true } per turn.
		expect(mock.getSetActiveCalls()).toHaveLength(callsAfterRestore);
		expect(changedSpy).not.toHaveBeenCalled();
		// The restore pass itself never handed a hidden name to pi.
		for (const call of mock.getSetActiveCalls()) {
			expect(call).not.toContain("hidden.tool");
		}

		// A reconciler force-adds the hidden name — pi itself would drop it,
		// and the re-assert must not treat that as drift either.
		mock.setActiveTools(["search.web", "hidden.tool"]);
		mock.fireLifecycleEvent("before_agent_start");
		expect(pi.getActiveTools()).toEqual(["search.web"]);
		expect(changedSpy).not.toHaveBeenCalled();
		expect(mock.getSetActiveCalls()).toHaveLength(callsAfterRestore + 1); // only the manual call
	});
});

// ===================================================================
// effectiveEnabled — exported intent resolver
// ===================================================================

describe("effectiveEnabled", () => {
	function branchOf(mock: MockPI) {
		return mock.createContext().sessionManager.getBranch();
	}

	it("resolves a chat-branch entry (tier 1) with no mode argument", () => {
		const { mock, pi } = createEnv();
		const spec = makeSpec({ persistKey: "k:a", defaultEnabled: false });
		pi.appendEntry("k:a", { enabled: true });

		expect(effectiveEnabled(spec, branchOf(mock), {})).toEqual({
			enabled: true,
			persistedEntry: true,
		});
	});

	it("resolves a settings pin (tier 2), then the packaged fallback (tier 3)", () => {
		const { mock } = createEnv();
		setDefaultsOverride({ "k:a": { enabled: true } });
		const pinned = makeSpec({ persistKey: "k:a", defaultEnabled: false });
		expect(effectiveEnabled(pinned, branchOf(mock), readMergedToolsetDefaults())).toEqual({
			enabled: true,
			persistedEntry: false,
		});

		const unpinned = makeSpec({ persistKey: "k:b", defaultEnabled: false });
		expect(effectiveEnabled(unpinned, branchOf(mock), {})).toEqual({
			enabled: false,
			persistedEntry: false,
		});
	});

	it("null-tombstoned entry falls through to the next tier", () => {
		const { mock, pi } = createEnv();
		pi.appendEntry("k:a", { enabled: true });
		pi.appendEntry("k:a", null);
		const spec = makeSpec({ persistKey: "k:a", defaultEnabled: false });

		expect(effectiveEnabled(spec, branchOf(mock), {})).toEqual({
			enabled: false,
			persistedEntry: false,
		});
	});

	it("allowlist mode: the set-level override is authoritative — suppressed resolves false, allowlisted true", () => {
		const { mock, pi } = createEnv();
		pi.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: ["allowed.web"],
		});

		// A branch entry and a settings pin both say true, but the toolset is
		// not allowlisted — the mask suppresses it.
		pi.appendEntry("k:suppressed", { enabled: true });
		setDefaultsOverride({ "k:suppressed": { enabled: true } });
		const suppressed = makeSpec({
			id: "suppressed.web",
			persistKey: "k:suppressed",
		});
		expect(
			effectiveEnabled(suppressed, branchOf(mock), readMergedToolsetDefaults()),
		).toEqual({ enabled: false, persistedEntry: true });

		// Allowlisted: branch entry and settings pin say false, allowlist wins.
		pi.appendEntry("k:allowed", { enabled: false });
		setDefaultsOverride({ "k:allowed": { enabled: false } });
		const allowed = makeSpec({ id: "allowed.web", persistKey: "k:allowed" });
		expect(
			effectiveEnabled(allowed, branchOf(mock), readMergedToolsetDefaults()),
		).toEqual({ enabled: true, persistedEntry: true });
	});

	it("exclusion mode (default): no allowlist fallthrough — tier chain applies", () => {
		const { mock, pi } = createEnv();
		const spec = makeSpec({ persistKey: "k:a", defaultEnabled: true });
		// A stale allowlist field in a non-allowlist mode entry is ignored.
		pi.appendEntry("toolset-resolution-mode", { mode: "exclusion" });

		expect(effectiveEnabled(spec, branchOf(mock), {})).toEqual({
			enabled: true,
			persistedEntry: false,
		});
	});
});

// ===================================================================
// Intent-delta gate — branch-threaded reads, ToggleResult[]
// ===================================================================

describe("intent-delta gate", () => {
	/** Simulate another extension's setActiveTools replacing the whole
	 *  active set while this toolset's recorded intent stays on. */
	function clobberOff(mock: MockPI, names: string[]): void {
		mock.setActiveTools(names);
	}

	it("disable of an absent member persists the off entry (delta gate), does not revive peers", () => {
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
		const callsBefore = mock.getSetActiveCalls().length;
		const results = defineToolset(
			pi,
			makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a"]) }),
		).disable(pi, reader(pi));
		// Intent on (default tier), nothing active: no loadout write, but the
		// off toggle is a real intent delta — it persists and emits.
		expect(emitSpy).toHaveBeenCalledWith(TOOLSET_EVENTS.changed, {
			id: "A",
			enabled: false,
		});
		expect(mock.getEntries("k:A")).toEqual([
			{ customType: "k:A", data: { enabled: false } },
		]);
		expect(results).toEqual([{ id: "A", enabled: false }]);
		expect(mock.getSetActiveCalls()).toHaveLength(callsBefore);
		expect(mock.getActiveTools()).toEqual(["b"]);
		emitSpy.mockRestore();
	});

	it("clobber repair: clobbered-active toolset, user toggles off → off entry + emit, no setActiveTools", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi)); // intent on, member active
		clobberOff(mock, []); // external removal — intent still on
		expect(pi.getActiveTools()).toEqual([]);

		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));
		const callsBefore = mock.getSetActiveCalls().length;

		const results = ts.disable(pi, reader(pi));

		// The bug fix: the off toggle is no longer dropped in the clobbered
		// window — intent delta fires, no redundant loadout write. (The enable's
		// on entry precedes the off entry.)
		expect(results).toEqual([{ id: "test.toolset", enabled: false }]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(2);
		expect(mock.getEntries("toolset-state:test.toolset").at(-1)).toEqual({
			customType: "toolset-state:test.toolset",
			data: { enabled: false },
		});
		expect(changed).toEqual([{ id: "test.toolset", enabled: false }]);
		expect(mock.getSetActiveCalls()).toHaveLength(callsBefore);
		expect(pi.getActiveTools()).toEqual([]);
	});

	it("repeat off is silent: no entry, no emit, no setActiveTools", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi));
		ts.disable(pi, reader(pi)); // on + off entries recorded
		const entriesBefore = mock.getEntries("toolset-state:test.toolset").length;

		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));
		const callsBefore = mock.getSetActiveCalls().length;

		const results = ts.disable(pi, reader(pi));

		expect(results).toEqual([]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(
			entriesBefore,
		);
		expect(changed).toEqual([]);
		expect(mock.getSetActiveCalls()).toHaveLength(callsBefore);
	});

	it("repeat on is silent: no entry, no emit, no setActiveTools", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi)); // on entry written, member active

		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));
		const callsBefore = mock.getSetActiveCalls().length;

		const results = ts.enable(pi, reader(pi));

		expect(results).toEqual([]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(1);
		expect(changed).toEqual([]);
		expect(mock.getSetActiveCalls()).toHaveLength(callsBefore);
	});

	it("enable after clobber is a loud repair: loadout write + entry + emit", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi, reader(pi));
		clobberOff(mock, []); // clobbered off externally, intent still on

		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));
		const callsBefore = mock.getSetActiveCalls().length;

		const results = ts.enable(pi, reader(pi));

		// Loud repair: the loadout write (toAdd) is the rule pair's second
		// disjunct — entry + emit fire even though the intent value is
		// unchanged. Exactly one NEW write beyond the clobber.
		expect(results).toEqual([{ id: "test.toolset", enabled: true }]);
		expect(mock.getSetActiveCalls()).toHaveLength(callsBefore + 1);
		expect(pi.getActiveTools()).toEqual(["tool-a"]);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([
			{ customType: "toolset-state:test.toolset", data: { enabled: true } },
			{ customType: "toolset-state:test.toolset", data: { enabled: true } },
		]);
		expect(changed).toEqual([{ id: "test.toolset", enabled: true }]);
	});

	it("residue: resolved off, member still active → removal + re-affirmed off entry + emit", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		mock.registerTool({ name: "unrelated", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.disable(pi, reader(pi)); // resolved off, nothing active — silent
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(1);

		// A stray member appears (external force-add) while intent is off.
		mock.setActiveTools(["tool-a", "unrelated"]);
		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		const results = ts.disable(pi, reader(pi));

		// Loadout write fires; the off entry is re-affirmed (no NEW value —
		// still {enabled: false}); enabled reports post-state.
		expect(results).toEqual([{ id: "test.toolset", enabled: false }]);
		expect(pi.getActiveTools()).toEqual(["unrelated"]);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([
			{ customType: "toolset-state:test.toolset", data: { enabled: false } },
			{ customType: "toolset-state:test.toolset", data: { enabled: false } },
		]);
		expect(changed).toEqual([{ id: "test.toolset", enabled: false }]);
	});

	it("external branch write is visible: focusRelease-style direct false write, then enable fires", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));

		// External writer appends the intent directly (tbox focusRelease shape).
		pi.appendEntry("toolset-state:test.toolset", { enabled: false });

		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (data: any) => changed.push(data));

		const results = ts.enable(pi, reader(pi));

		expect(results).toEqual([{ id: "test.toolset", enabled: true }]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(2);
		expect(changed).toEqual([{ id: "test.toolset", enabled: true }]);
	});

	it("settings-pin delta: pin off, repeat off silent, toggle on persists", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setDefaultsOverride({ "toolset-state:test.toolset": { enabled: false } });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));

		// Repeat off against the pin: resolved off, delta zero — silent.
		expect(ts.disable(pi, reader(pi))).toEqual([]);
		expect(mock.getEntries("toolset-state:test.toolset")).toHaveLength(0);

		// Toggle on: delta vs the pin → entry persists, overriding the pin.
		const results = ts.enable(pi, reader(pi));
		expect(results).toEqual([{ id: "test.toolset", enabled: true }]);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([
			{ customType: "toolset-state:test.toolset", data: { enabled: true } },
		]);
	});

	it("cascade shares one settings snapshot: hub + dependent pinned on, no branch entries → one call persists both, second call silent", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "hub-a", description: "" });
		mock.registerTool({ name: "dep-b", description: "" });
		// Both pinned on via settings, no branch entries: resolved on.
		setDefaultsOverride({ "k:hub": { enabled: true }, "k:dep": { enabled: true } });
		const ts = defineToolset(
			pi,
			makeSpec({ id: "hub", persistKey: "k:hub", names: new Set(["hub-a"]) }),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "dep",
				persistKey: "k:dep",
				names: new Set(["dep-b"]),
				requires: ["hub"],
			}),
		);

		const first = ts.disable(pi, reader(pi));
		expect(first).toEqual([
			{ id: "hub", enabled: false },
			{ id: "dep", enabled: false },
		]);

		// Delta zero for the whole cascade against the one snapshot.
		const second = ts.disable(pi, reader(pi));
		expect(second).toEqual([]);
		expect(mock.getEntries("k:hub")).toHaveLength(1);
		expect(mock.getEntries("k:dep")).toHaveLength(1);
	});

	it("empty branch is a legitimate state: settings pin supplies the resolved tier", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });
		setDefaultsOverride({ "toolset-state:test.toolset": { enabled: true } });
		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));

		// A reader over a fresh session: getBranch() genuinely returns []
		// pre-write; after the off entry is appended the live read sees it.
		const results = ts.disable(pi, reader(pi));

		// Tier chain, not a branchless convention: the pin resolves on, so the
		// off toggle is a real delta and persists. The report is the value the
		// call persisted and emitted — `false`, matching the off entry.
		expect(results).toEqual([{ id: "test.toolset", enabled: false }]);
		expect(mock.getEntries("toolset-state:test.toolset")).toEqual([
			{ customType: "toolset-state:test.toolset", data: { enabled: false } },
		]);
	});

	it("cascade diamond (per-call applied set): enable(A) writes exactly one entry per toolset, D once in the result", () => {
		const { mock, pi } = createEnv();
		for (const name of ["a", "b", "c", "d"]) {
			mock.registerTool({ name, description: "" });
		}
		const tsA = defineToolset(
			pi,
			makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a"]), requires: ["B", "C"] }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b"]), requires: ["D"] }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "C", persistKey: "k:C", names: new Set(["c"]), requires: ["D"] }),
		);
		const tsD = defineToolset(
			pi,
			makeSpec({ id: "D", persistKey: "k:D", names: new Set(["d"]) }),
		);

		const results = tsA.enable(pi, reader(pi));

		// Exactly one entry per toolset in the result — D reached twice via
		// B and C, its second reach is skipped by the per-call `applied` set.
		expect(results).toEqual([
			{ id: "D", enabled: true },
			{ id: "B", enabled: true },
			{ id: "C", enabled: true },
			{ id: "A", enabled: true },
		]);
		// Exactly one branch entry per toolset.
		for (const key of ["k:A", "k:B", "k:C", "k:D"]) {
			expect(mock.getEntries(key)).toHaveLength(1);
		}
		// The falsifier for the "exactly once" rule: D's own disable right
		// after is a real delta (off), and its cascade over B and C — resolved
		// off by the entries above — stays silent for the already-off deps.
		expect(tsD.disable(pi, reader(pi))).toEqual([
			{ id: "D", enabled: false },
			{ id: "B", enabled: false },
			{ id: "A", enabled: false },
			{ id: "C", enabled: false },
		]);
		for (const key of ["k:A", "k:B", "k:C", "k:D"]) {
			expect(mock.getEntries(key)).toHaveLength(2);
		}
	});

	it("disable mirror: shared grandchild-dependent gets exactly one entry", () => {
		const { mock, pi } = createEnv();
		for (const name of ["a", "b", "c", "d"]) {
			mock.registerTool({ name, description: "" });
		}
		const tsA = defineToolset(
			pi,
			makeSpec({ id: "A", persistKey: "k:A", names: new Set(["a"]) }),
		);
		const tsB = defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b"]), requires: ["A"] }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "C", persistKey: "k:C", names: new Set(["c"]), requires: ["A"] }),
		);
		defineToolset(
			pi,
			makeSpec({ id: "D", persistKey: "k:D", names: new Set(["d"]), requires: ["B", "C"] }),
		);

		const results = tsA.disable(pi, reader(pi));

		// D is a dependent of both B and C: the second reach is skipped by the
		// per-call `applied` set — one row, one entry.
		expect(results).toEqual([
			{ id: "A", enabled: false },
			{ id: "B", enabled: false },
			{ id: "D", enabled: false },
			{ id: "C", enabled: false },
		]);
		for (const key of ["k:A", "k:B", "k:C", "k:D"]) {
			expect(mock.getEntries(key)).toHaveLength(1);
		}
		// A dependent's own toggle immediately after the cascade: delta zero.
		expect(tsB.disable(pi, reader(pi))).toEqual([]);
	});

	it("sequential toggles share one reader: learn's cascade does not re-append web", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "" });
		mock.registerTool({ name: "learn-a", description: "" });
		const web = defineToolset(
			pi,
			makeSpec({ id: "web", persistKey: "k:web", names: new Set(["web-a"]) }),
		);
		const learn = defineToolset(
			pi,
			makeSpec({ id: "learn", persistKey: "k:learn", names: new Set(["learn-a"]), requires: ["web"] }),
		);

		const shared = reader(pi);
		const r1 = web.enable(pi, shared);
		const r2 = learn.enable(pi, shared);

		expect(r1).toEqual([{ id: "web", enabled: true }]);
		expect(r2).toEqual([{ id: "learn", enabled: true }]);
		// Exactly one on entry per toolset — learn's cascade re-applying web
		// re-invokes the reader, sees web's entry, and stays silent.
		expect(mock.getEntries("k:web")).toHaveLength(1);
		expect(mock.getEntries("k:learn")).toHaveLength(1);
	});
});

// ===================================================================
// Allowlist boundary — every interactive toggle under allowlist
// governance throws AllowlistModeError, atomically (nothing runs)
// ===================================================================

describe("allowlist boundary — toggle refusal", () => {
	function setupBoundary(allowlist: string[]) {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "in-a", description: "" });
		mock.registerTool({ name: "out-b", description: "" });
		const listed = defineToolset(
			pi,
			makeSpec({
				id: "in.web",
				persistKey: "k:in",
				names: new Set(["in-a"]),
				defaultEnabled: true,
			}),
		);
		const unlisted = defineToolset(
			pi,
			makeSpec({
				id: "out.web",
				persistKey: "k:out",
				names: new Set(["out-b"]),
				defaultEnabled: true,
			}),
		);
		if (allowlist.length > 0) {
			setDefaultResolutionMode(pi, "allowlist", allowlist);
		}
		const changed: unknown[] = [];
		pi.events.on(TOOLSET_EVENTS.changed, (d: unknown) => changed.push(d));
		return { mock, pi, listed, unlisted, changed };
	}

	it("throws AllowlistModeError for all four quadrants — atomic, byte-identical state", () => {
		// Four quadrants (enable/disable × listed/unlisted), each pinned with
		// members both active and inactive — the refusal must not depend on
		// either the requested value or the observed state.
		for (const activeFirst of [true, false]) {
			for (const useEnable of [true, false]) {
				for (const inList of [true, false]) {
					const { mock, pi, listed, unlisted, changed } =
						setupBoundary(["in.web"]);
					if (activeFirst) {
						mock.setActiveTools(inList ? ["in-a"] : ["out-b"]);
					} else {
						mock.setActiveTools([]);
					}
					const before = mock.getActiveTools();
					const ts = inList ? listed : unlisted;
					const err = catchByName(() =>
						useEnable
							? ts.enable(pi, reader(pi))
							: ts.disable(pi, reader(pi)),
					);
					expect(err?.name).toBe("AllowlistModeError");
					// Atomicity pins, every quadrant: no entry, no emit, no
					// loadout write — the check precedes the cascade.
					expect(mock.getEntries("k:in")).toHaveLength(0);
					expect(mock.getEntries("k:out")).toHaveLength(0);
					expect(changed).toHaveLength(0);
					expect(mock.getActiveTools()).toEqual(before);
				}
			}
		}
	});

	it("the cascade never starts: enable(A) with A listed and requiring B leaves B untouched", () => {
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
		defineToolset(
			pi,
			makeSpec({ id: "B", persistKey: "k:B", names: new Set(["b-tool"]) }),
		);
		setDefaultResolutionMode(pi, "allowlist", ["A"]);
		mock.setActiveTools(["a-tool"]);
		const before = mock.getActiveTools();

		const err = catchByName(() => tsA.enable(pi, reader(pi)));
		expect(err?.name).toBe("AllowlistModeError");

		// Zero branch entries anywhere (the mode entry from setup excepted),
		// B untouched, active set byte-identical.
		expect(mock.getEntries("k:A")).toHaveLength(0);
		expect(mock.getEntries("k:B")).toHaveLength(0);
		expect(mock.getActiveTools()).toEqual(before);
	});

	it("mode source is the branch, not module state: a raw-appended mode entry throws with no setDefaultResolutionMode call", () => {
		const { mock, pi, listed } = setupBoundary([]);
		// No setDefaultResolutionMode — the branch carries no mode entry yet.
		expect(readBranchModeState(reader(pi).getBranch()).mode).toBe("exclusion");
		mock.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: ["in.web"],
		});
		const err = catchByName(() => listed.enable(pi, reader(pi)));
		expect(err?.name).toBe("AllowlistModeError");
		expect(mock.getEntries("k:in")).toHaveLength(0);
	});

	it("empty branch does not throw — absent mode entry resolves to exclusion", () => {
		const { mock, pi, listed } = setupBoundary([]);
		const results = listed.enable(pi, reader(pi));
		expect(results).toEqual([{ id: "in.web", enabled: true }]);
		expect(mock.getEntries("k:in")).toHaveLength(1);
	});

	it("forceToolsetEnabled stays live under allowlist — still applies and emits", () => {
		const { mock, pi, changed } = setupBoundary(["in.web"]);
		forceToolsetEnabled(
			pi,
			{ id: "out.web", persistKey: "k:out", names: new Set(["out-b"]) },
			true,
		);
		expect(mock.getActiveTools()).toEqual(["out-b"]);
		expect(changed).toEqual([{ id: "out.web", enabled: true }]);
	});

	it("AllowlistModeError object contract: name, specId, one-sentence message", () => {
		const err = new AllowlistModeError("out.web");
		expect(err.name).toBe("AllowlistModeError");
		expect(err.specId).toBe("out.web");
		expect(err.message).toContain("out.web");
		expect(err.message).toContain("allowlist");
	});
});

// ===================================================================
// toggleBatch — public batch boundary (the sole toggle actuation path;
// the two-method surface is single-op wrappers delegating to it)
// ===================================================================

describe("toggleBatch — public batch boundary", () => {
	function setupBatch(allowlist: string[] = []) {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		// A resolves off by default, B on — a fresh rig has one of each
		// direction available for a mixed batch.
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				defaultEnabled: false,
			}),
		);
		const tsB = defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
				defaultEnabled: true,
			}),
		);
		if (allowlist.length > 0) {
			setDefaultResolutionMode(pi, "allowlist", allowlist);
		}
		const changed: unknown[] = [];
		pi.events.on(TOOLSET_EVENTS.changed, (d: unknown) => changed.push(d));
		return { mock, pi, tsA, tsB, changed };
	}

	it("allowlist refusal covers the whole batch in one throw — atomic, no specId", () => {
		const { mock, pi, changed } = setupBatch(["A"]);
		mock.setActiveTools(["a-tool", "b-tool"]);
		const before = mock.getActiveTools();
		const err = catchByName(() =>
			toggleBatch(pi, reader(pi), [
				{ id: "A", desired: true },
				{ id: "B", desired: false },
			]),
		);
		expect(err?.name).toBe("AllowlistModeError");
		// Mode-global refusal attributes nothing — the caller knows its own
		// op list.
		expect(err?.specId).toBeUndefined();
		// Atomicity: no entry, no emit, no loadout write.
		expect(mock.getEntries("k:A")).toHaveLength(0);
		expect(mock.getEntries("k:B")).toHaveLength(0);
		expect(changed).toHaveLength(0);
		expect(mock.getActiveTools()).toEqual(before);
	});

	it("empty ops returns [] before the mode check — silent no-op under allowlist governance too", () => {
		const { mock, pi, changed } = setupBatch(["A"]);
		expect(toggleBatch(pi, reader(pi), [])).toEqual([]);
		expect(mock.getEntries("k:A")).toHaveLength(0);
		expect(changed).toHaveLength(0);
	});

	it("deferring child: batch returns [] before the mode check", () => {
		const { mock, pi, changed } = setupBatch(["A"]);
		mock.setActiveTools(["a-tool", "b-tool"]);
		process.env["PI_TOOLMASKING_DEFER"] = "999999"; // foreign pid — defer
		try {
			expect(
				toggleBatch(pi, reader(pi), [{ id: "A", desired: true }]),
			).toEqual([]);
		} finally {
			delete process.env["PI_TOOLMASKING_DEFER"];
		}
		expect(mock.getEntries("k:A")).toHaveLength(0);
		expect(changed).toHaveLength(0);
		expect(mock.getActiveTools()).toEqual(["a-tool", "b-tool"]);
	});

	it("explicit op naming an unregistered id throws atomically — nothing written, nothing emitted", () => {
		const { mock, pi, changed } = setupBatch();
		const err = catchByName(() =>
			toggleBatch(pi, reader(pi), [{ id: "ghost", desired: true }]),
		);
		expect(err?.name).not.toBe("AllowlistModeError");
		expect(err?.name).not.toBe("CycleError");
		expect(err?.name).not.toBe("ContradictionError");
		expect(mock.getEntries("k:A")).toHaveLength(0);
		expect(mock.getEntries("k:B")).toHaveLength(0);
		expect(changed).toHaveLength(0);
	});

	it("mixed multi-op batch: flattened intent delta, entries + emits in discovery order", () => {
		const { mock, pi, changed } = setupBatch();
		// before: A off (default), B on (default) — the batch flips both,
		// one up and one down.
		const results = toggleBatch(pi, reader(pi), [
			{ id: "A", desired: true },
			{ id: "B", desired: false },
		]);
		expect(results).toEqual([
			{ id: "A", enabled: true },
			{ id: "B", enabled: false },
		]);
		expect(mock.getEntries("k:A").map((e) => e.data)).toEqual([{ enabled: true }]);
		expect(mock.getEntries("k:B").map((e) => e.data)).toEqual([{ enabled: false }]);
		expect(changed).toEqual([
			{ id: "A", enabled: true },
			{ id: "B", enabled: false },
		]);
		expect(mock.getActiveTools()).toEqual(["a-tool"]);
	});

	it("duplicate ops dedupe silently; an op already in its desired state is absent from the delta", () => {
		const { mock, pi, changed } = setupBatch();
		// before: A off, B on — disabling A is already-in-state (silent),
		// enabling B is the only delta; the duplicate op dedupes.
		const results = toggleBatch(pi, reader(pi), [
			{ id: "A", desired: false },
			{ id: "B", desired: true },
			{ id: "B", desired: true },
		]);
		expect(results).toEqual([{ id: "B", enabled: true }]);
		expect(mock.getEntries("k:A")).toHaveLength(0); // no re-persist
		expect(mock.getEntries("k:B").map((e) => e.data)).toEqual([{ enabled: true }]);
		expect(changed).toEqual([{ id: "B", enabled: true }]);
	});

	it("wrapper delegation: Toolset.enable(pi, sm) ≡ toggleBatch(pi, sm, [{ id, desired: true }])", () => {
		const runEnable = (
			via: "wrapper" | "batch",
		): { entries: unknown[]; changed: unknown[]; tools: string[] } => {
			const { mock, pi, tsA, changed } = setupBatch();
			if (via === "wrapper") {
				tsA.enable(pi, reader(pi));
			} else {
				toggleBatch(pi, reader(pi), [{ id: "A", desired: true }]);
			}
			return {
				entries: mock.getEntries("k:A").map((e) => e.data),
				changed: [...changed],
				tools: mock.getActiveTools(),
			};
		};
		const viaWrapper = runEnable("wrapper");
		const viaBatch = runEnable("batch");
		expect(viaWrapper).toEqual(viaBatch);
		expect(viaBatch.entries).toEqual([{ enabled: true }]);
		expect(viaBatch.tools).toEqual(["a-tool"]);
	});

	it("wrapper delegation (disable mirror): Toolset.disable(pi, sm) ≡ toggleBatch(pi, sm, [{ id, desired: false }])", () => {
		const runDisable = (
			via: "wrapper" | "batch",
		): { entries: unknown[]; changed: unknown[]; tools: string[] } => {
			const { mock, pi, tsB, changed } = setupBatch();
			if (via === "wrapper") {
				tsB.disable(pi, reader(pi));
			} else {
				toggleBatch(pi, reader(pi), [{ id: "B", desired: false }]);
			}
			return {
				entries: mock.getEntries("k:B").map((e) => e.data),
				changed: [...changed],
				tools: mock.getActiveTools(),
			};
		};
		const viaWrapper = runDisable("wrapper");
		const viaBatch = runDisable("batch");
		expect(viaWrapper).toEqual(viaBatch);
		expect(viaBatch.entries).toEqual([{ enabled: false }]);
		expect(viaBatch.tools).toEqual([]);
	});

	it("through the wrappers the refusal keeps its specId — bit-identical to the single-toggle contract", () => {
		const { mock, pi, tsA } = setupBatch(["A"]);
		mock.setActiveTools(["a-tool"]);
		const err = catchByName(() => tsA.enable(pi, reader(pi)));
		expect(err?.name).toBe("AllowlistModeError");
		expect(err?.specId).toBe("A");
	});

	it("cycle reachable from any op throws CycleError before any write or emit", () => {
		const { mock, pi, changed } = setupBatch();
		mock.registerTool({ name: "c1-tool", description: "" });
		mock.registerTool({ name: "c2-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "C1",
				persistKey: "k:C1",
				names: new Set(["c1-tool"]),
				requires: ["C2"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "C2",
				persistKey: "k:C2",
				names: new Set(["c2-tool"]),
				requires: ["C1"],
			}),
		);
		const err = catchByName(() =>
			toggleBatch(pi, reader(pi), [
				{ id: "C1", desired: true },
				{ id: "B", desired: false },
			]),
		);
		expect(err?.name).toBe("CycleError");
		expect(mock.getEntries("k:A")).toHaveLength(0);
		expect(mock.getEntries("k:B")).toHaveLength(0);
		expect(mock.getEntries("k:C1")).toHaveLength(0);
		expect(mock.getEntries("k:C2")).toHaveLength(0);
		expect(changed).toHaveLength(0);
	});

	// Public-path mirror of the CycleError pin above: the README's "nothing
	// is written" promise covers the contradiction refusal too.
	it("contradictory batch throws ContradictionError before any write or emit", () => {
		const { mock, pi, changed } = setupBatch();
		mock.registerTool({ name: "x-tool", description: "" });
		mock.registerTool({ name: "y-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "X",
				persistKey: "k:X",
				names: new Set(["x-tool"]),
				requires: ["Y"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "Y",
				persistKey: "k:Y",
				names: new Set(["y-tool"]),
			}),
		);
		const before = mock.getActiveTools();
		const err = catchByName(() =>
			toggleBatch(pi, reader(pi), [
				{ id: "X", desired: true },
				{ id: "Y", desired: false },
			]),
		);
		expect(err?.name).toBe("ContradictionError");
		expect(mock.getEntries("k:X")).toHaveLength(0);
		expect(mock.getEntries("k:Y")).toHaveLength(0);
		expect(changed).toHaveLength(0);
		expect(mock.getActiveTools()).toEqual(before);
	});
});

// ===================================================================
// Branch-read unification — dispatcher arm selection + copy semantics
// ===================================================================

describe("branch-read unification — dispatcher arm + copy semantics", () => {
	/** Two toolsets, registered but with NO restore and NO mode entry — the
	 *  fresh-process/no-restore window where arm selection must come from the
	 *  branch alone (an absent entry resolves to exclusion). */
	function setupFresh(): { mock: MockPI; pi: ExtensionAPI } {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "search.web", description: "" });
		mock.registerTool({ name: "leak.tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "search.web",
				persistKey: "tbox.tool@search",
				names: new Set(["search.web"]),
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "leak.web",
				persistKey: "k:leak",
				names: new Set(["leak.tool"]),
			}),
		);
		return { mock, pi };
	}

	it("a raw-appended allowlist mode entry selects the allowlist arm — enforced from the first turn, no restore, no module write", () => {
		const { mock, pi } = setupFresh();
		// Raw branch write — setDefaultResolutionMode is never called, so no
		// library API has touched this mode before. A module-state mirror would
		// read empty here; the branch read must win.
		mock.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: ["search.web"],
		});
		mock.setActiveTools(["search.web", "leak.tool"]);
		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);

		mock.fireLifecycleEvent("before_agent_start");

		// Allowlist arm: the leak is removed, changed emitted for the
		// suppressed toolset.
		expect(pi.getActiveTools()).toEqual(["search.web"]);
		expect(changedSpy).toHaveBeenCalledTimes(1);
		expect(changedSpy).toHaveBeenCalledWith({ id: "leak.web", enabled: false });
	});

	it("no mode entry selects the exclusion arm — branch tier enforced from raw entries alone", () => {
		const { mock, pi } = setupFresh();
		// No mode entry anywhere; a raw branch entry pins leak.web off.
		mock.appendEntry("k:leak", { enabled: false });
		mock.setActiveTools(["search.web", "leak.tool"]);
		const changedSpy = vi.fn();
		pi.events.on(TOOLSET_EVENTS.changed, changedSpy);

		mock.fireLifecycleEvent("before_agent_start");

		// Exclusion arm: effectively-off toolset's force-added tool removed.
		expect(pi.getActiveTools()).toEqual(["search.web"]);
		expect(changedSpy).toHaveBeenCalledTimes(1);
		expect(changedSpy).toHaveBeenCalledWith({ id: "leak.web", enabled: false });
	});

	it("corrupt allowlist array fails closed to [] — every registered toolset suppressed", () => {
		const { mock, pi } = setupFresh();
		mock.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: "garbage",
		});
		mock.setActiveTools(["search.web", "leak.tool"]);

		mock.fireLifecycleEvent("before_agent_start");

		expect(pi.getActiveTools()).toEqual([]);
	});

	it("read-side copy: the returned allowlist is fresh every call — mutating it never touches the branch", () => {
		const { mock, pi } = setupFresh();
		mock.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: ["search.web"],
		});
		const branch = reader(pi).getBranch();

		const first = readBranchModeState(branch);
		expect(first.mode).toBe("allowlist");
		expect(first.allowlist).toEqual(["search.web"]);
		first.allowlist.push("leak.web");

		// Second call is unaffected, and the branch entry data is untouched.
		const second = readBranchModeState(branch);
		expect(second.allowlist).toEqual(["search.web"]);
		const modeEntry = mock.getEntries("toolset-resolution-mode")[0];
		expect(modeEntry?.data).toEqual({
			mode: "allowlist",
			allowlist: ["search.web"],
		});
	});

	it("write-side copy: mutating the array after setDefaultResolutionMode never edits the branch", () => {
		const { mock, pi } = setupFresh();
		const allowlist = ["search.web"];
		setDefaultResolutionMode(pi, "allowlist", allowlist);

		// Caller mutates the array AFTER the call — persisted governance must
		// not follow (pi stores entry data by reference; the write site owns
		// the value).
		allowlist.push("leak.web");

		const modeEntry = mock.getEntries("toolset-resolution-mode")[0];
		expect(modeEntry?.data).toEqual({
			mode: "allowlist",
			allowlist: ["search.web"],
		});
	});
});
