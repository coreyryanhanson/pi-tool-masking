import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect } from "vitest";
import { MockPI } from "./mock-pi.js";
import {
	defineToolset,
	setDefaultResolutionMode,
	getDefaultResolutionMode,
} from "../index.js";

function createEnv(): { mock: MockPI; pi: ExtensionAPI } {
	const mock = new MockPI();
	return { mock, pi: mock as unknown as ExtensionAPI };
}

const REGISTRY_KEY = "__piToolMaskingRegistry";
const HANDLER_GUARD_KEY = "__piToolMaskingRestoreHandlerRegistered";
const MODULE_STATE_KEY = "__piToolMaskingModuleState";

function cleanRegistry(): void {
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[HANDLER_GUARD_KEY];
	delete (globalThis as any)[MODULE_STATE_KEY];
}

function makeSpec(
	overrides: Partial<{
		id: string;
		persistKey: string;
		names: Set<string>;
		defaultEnabled: boolean;
		requires: string[];
		masked: boolean;
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

// ---------------------------------------------------------------------------
// §9 Dependency cascade on enable
// ---------------------------------------------------------------------------

describe("Dependency cascade on enable (§9, §4.4)", () => {
	it("L requires [B]; enable(L) → B enabled", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });

		const tsB = defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
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

		// Both B and L tools should be active
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
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
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

		// Disable B → L should also be disabled
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
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
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

		// Start with B enabled independently
		tsB.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);

		// Disable B independently (before L is enabled)
		tsB.disable(pi);
		expect(tsB.isEnabled(pi)).toBe(false);

		// Now enable L — B should be re-enabled via cascade
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
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
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

		// Enable L (cascades to B)
		tsL.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);

		// Directly remove B's tool via setActiveTools (simulates external interference)
		const withoutB = mock
			.getActiveTools()
			.filter((n: string) => n !== "b-tool");
		mock.setActiveTools(withoutB);

		// Now B is off, but L's tools are still on — invariant violated
		// (This simulates state corruption — the cascade is a guarantee on
		// toggle operations, not on arbitrary external mutation)
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
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
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
});

// ---------------------------------------------------------------------------
// §4.4 Cycle detection
// ---------------------------------------------------------------------------

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
		// The path should show A → B → C → A (or similar cycle path)
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
			makeSpec({
				id: "D",
				persistKey: "k:D",
				names: new Set(["d-tool"]),
			}),
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

		// Diamond: A→B→D, A→C→D — shared D, no cycle
		expect(() => tsA.enable(pi)).not.toThrow();
		expect(mock.getActiveTools()).toContain("a-tool");
		expect(mock.getActiveTools()).toContain("b-tool");
		expect(mock.getActiveTools()).toContain("c-tool");
		expect(mock.getActiveTools()).toContain("d-tool");
	});
});

// ---------------------------------------------------------------------------
// Forward references (§4.4)
// ---------------------------------------------------------------------------

describe("Forward references (§4.4)", () => {
	it("defineToolset with forward ref does not throw on enable", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });

		// Define A with requires: ["B"] before B is registered
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);

		// B not registered yet — cascade just skips the forward reference
		expect(() => tsA.enable(pi)).not.toThrow();
		expect(tsA.isEnabled(pi)).toBe(true);
	});

	it("re-enable after forward ref is registered cascades to it", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });

		// Define A with forward ref to B
		const tsA = defineToolset(
			pi,
			makeSpec({
				id: "A",
				persistKey: "k:A",
				names: new Set(["a-tool"]),
				requires: ["B"],
			}),
		);

		// Enable A — B not registered yet, A works alone
		tsA.enable(pi);
		expect(mock.getActiveTools()).toEqual(["a-tool"]);

		// Now register B
		const tsB = defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
		);
		expect(tsB.isEnabled(pi)).toBe(false);

		// Re-enable A — cascade now finds B and enables it
		tsA.enable(pi);
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(mock.getActiveTools()).toContain("a-tool");
		expect(mock.getActiveTools()).toContain("b-tool");
	});
});

// ---------------------------------------------------------------------------
// §4.4 Reverse cascade on disable
// ---------------------------------------------------------------------------

describe("Reverse cascade on disable (§4.4, §9)", () => {
	it("linear chain: A requires B requires C — disable(B) cascades to A but not C", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "c-tool", description: "" });

		const tsC = defineToolset(
			pi,
			makeSpec({
				id: "C",
				persistKey: "k:C",
				names: new Set(["c-tool"]),
			}),
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

		// Enable A — cascades to B and C
		tsA.enable(pi);
		expect(tsA.isEnabled(pi)).toBe(true);
		expect(tsB.isEnabled(pi)).toBe(true);
		expect(tsC.isEnabled(pi)).toBe(true);

		// Disable B — A (depends on B) should be disabled,
		// but C (B's dependency, not dependent) remains enabled
		tsB.disable(pi);

		expect(tsB.isEnabled(pi)).toBe(false);
		expect(tsA.isEnabled(pi)).toBe(false); // A depends on B
		expect(tsC.isEnabled(pi)).toBe(true); // C is B's dep, not dependent
	});

	it("reverse cascade is idempotent — second disable is no-op", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });

		const tsB = defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
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

		// First disable — cascades to L
		tsB.disable(pi);
		const entryCount = mock.getEntries().length;
		const activeAfterFirst = mock.getActiveTools();

		// Second disable — should be no-op
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
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
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
		const tsX = defineToolset(
			pi,
			makeSpec({
				id: "X",
				persistKey: "k:X",
				names: new Set(["x-tool"]),
				requires: ["A"],
			}),
		);

		// Enable X — cascades to A, then to B
		tsX.enable(pi);
		expect(tsX.isEnabled(pi)).toBe(true);
		expect(tsA.isEnabled(pi)).toBe(true);
		expect(tsB.isEnabled(pi)).toBe(true);

		// Disable B — cascades to A (depends on B), then to X (depends on A)
		tsB.disable(pi);

		expect(tsB.isEnabled(pi)).toBe(false);
		expect(tsA.isEnabled(pi)).toBe(false);
		expect(tsX.isEnabled(pi)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// §4.4 Cycle detection on disable (reverse direction)
// ---------------------------------------------------------------------------

describe("Cycle detection on disable (§4.4)", () => {
	it("throws on disable of a toolset in a reverse cycle", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });

		// A requires B, B requires A — creates a cycle
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

		// Enable — this itself throws because of cycle
		expect(() => tsA.enable(pi)).toThrow("Cycle detected");
	});
});

// ---------------------------------------------------------------------------
// Mode setter/getter (§4.5)
// ---------------------------------------------------------------------------

describe("Default resolution mode setter/getter (§4.5)", () => {
	const dummyPI = {} as ExtensionAPI;

	it("defaults to exclusion", () => {
		expect(getDefaultResolutionMode(dummyPI)).toBe("exclusion");
	});

	it("set and get inclusion mode", () => {
		setDefaultResolutionMode(dummyPI, "inclusion");
		expect(getDefaultResolutionMode(dummyPI)).toBe("inclusion");
	});

	it("set and get exclusion mode", () => {
		setDefaultResolutionMode(dummyPI, "exclusion");
		expect(getDefaultResolutionMode(dummyPI)).toBe("exclusion");
	});

	it("mode persists in globalThis shared state across calls", () => {
		setDefaultResolutionMode(dummyPI, "inclusion");
		expect(getDefaultResolutionMode(dummyPI)).toBe("inclusion");

		setDefaultResolutionMode(dummyPI, "exclusion");
		expect(getDefaultResolutionMode(dummyPI)).toBe("exclusion");
	});
});

// ---------------------------------------------------------------------------
// §4.4 enable/disable cascade — appendEntry count checks
// ---------------------------------------------------------------------------

describe("Cascade appendEntry consistency (§4.4)", () => {
	it("enable(L) writes one entry for L and one for B (dependency)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });

		defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
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

		const lEntries = mock.getEntries("k:L");
		const bEntries = mock.getEntries("k:B");
		expect(lEntries).toHaveLength(1);
		expect(bEntries).toHaveLength(1);
	});

	it("disable cascades write entries for each affected toolset", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "b-tool", description: "" });
		mock.registerTool({ name: "l-tool", description: "" });

		const tsB = defineToolset(
			pi,
			makeSpec({
				id: "B",
				persistKey: "k:B",
				names: new Set(["b-tool"]),
			}),
		);
		// Enable L first (cascades to B)
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

		// Now disable B — should also disable L
		tsB.disable(pi);

		const lEntries = mock.getEntries("k:L");
		const bEntries = mock.getEntries("k:B");
		// L entry: enabled true (from enable) + enabled false (from cascade)
		expect(lEntries).toHaveLength(2);
		expect(lEntries[1]?.data).toEqual({ enabled: false });
		// B entry: enabled true (from enable cascade) + enabled false
		expect(bEntries).toHaveLength(2);
		expect(bEntries[1]?.data).toEqual({ enabled: false });
	});
});
