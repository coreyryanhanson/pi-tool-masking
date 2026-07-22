import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi } from "vitest";
import { MockPI } from "./mock-pi.js";
import {
	defineToolset,
	TOOLSET_EVENTS,
	setDefaultResolutionMode,
	getDefaultResolutionMode,
	readMergedSettings,
} from "../index.js";

// All tests use `mock` (MockPI) for mock-specific methods and
// `pi` (ExtensionAPI cast) for defineToolset/enable/disable calls.
function createEnv(): { mock: MockPI; pi: ExtensionAPI } {
	const mock = new MockPI();
	return { mock, pi: mock as unknown as ExtensionAPI };
}

const REGISTRY_KEY = "__piToolMaskingRegistry";
const HANDLER_GUARD_KEY = "__piToolMaskingRestoreHandlerRegistered";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanRegistry(): void {
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[HANDLER_GUARD_KEY];
	delete (globalThis as any)["__piToolMaskingModuleState"];
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
// §6.1 Registry
// ---------------------------------------------------------------------------

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

		defineToolset(pi, makeSpec({ id: "b.b", persistKey: "k:b.b" }));

		const regB = (globalThis as any)[REGISTRY_KEY];
		expect(regB).toBe(regA);
		expect(regB.size).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// defineToolset — validation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// defineToolset — restore handler registration
// ---------------------------------------------------------------------------

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

	it("registers handlers only once across multiple toolsets", () => {
		const { mock, pi } = createEnv();
		defineToolset(pi, makeSpec({ id: "a.a", persistKey: "k:a.a" }));
		defineToolset(pi, makeSpec({ id: "b.b", persistKey: "k:b.b" }));

		expect(mock.handlerCount("session_start")).toBe(1);
		expect(mock.handlerCount("session_tree")).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// defineToolset — collision policy
// ---------------------------------------------------------------------------

describe("defineToolset — collision policy", () => {
	it("warns and replaces on duplicate id with different spec", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi } = createEnv();

		defineToolset(pi, makeSpec({ id: "dup", persistKey: "k:dup" }));
		defineToolset(
			pi,
			makeSpec({ id: "dup", persistKey: "k:dup", defaultEnabled: false }),
		);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('Toolset "dup" re-registered'),
		);
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
			id: "portal.web",
			persistKey: "toolset-state:portal.web",
			names: new Set(["browser-navigate", "browser-click"]),
			defaultEnabled: true,
			requires: [],
		});
		const t1 = defineToolset(pi, spec1);

		const spec2 = makeSpec({
			id: "portal.web",
			persistKey: "toolset-state:portal.web",
			names: new Set(["browser-navigate", "browser-click"]),
			defaultEnabled: true,
			requires: [],
		});
		const t2 = defineToolset(pi, spec2);

		expect(t2).toBe(t1);
	});
});

// ---------------------------------------------------------------------------
// Toolset.enable
// ---------------------------------------------------------------------------

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

		ts.enable(pi); // second call

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

// ---------------------------------------------------------------------------
// Toolset.disable
// ---------------------------------------------------------------------------

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

		ts.disable(pi); // second call — already disabled

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

// ---------------------------------------------------------------------------
// Toolset.isEnabled
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Peer composition (§9 canonical test)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Default resolution mode (§4.5)
// ---------------------------------------------------------------------------

describe("Default resolution mode (§4.5)", () => {
	const dummyPI = {} as ExtensionAPI;

	it("starts in exclusion mode", () => {
		expect(getDefaultResolutionMode(dummyPI)).toBe("exclusion");
	});

	it("setDefaultResolutionMode switches mode", () => {
		setDefaultResolutionMode(dummyPI, "inclusion");
		expect(getDefaultResolutionMode(dummyPI)).toBe("inclusion");

		setDefaultResolutionMode(dummyPI, "exclusion");
		expect(getDefaultResolutionMode(dummyPI)).toBe("exclusion");
	});

	it("mode persists in globalThis shared state", () => {
		setDefaultResolutionMode(dummyPI, "inclusion");
		expect(getDefaultResolutionMode(dummyPI)).toBe("inclusion");
	});
});

// ---------------------------------------------------------------------------
// readMergedSettings
// ---------------------------------------------------------------------------

describe("readMergedSettings", () => {
	it("returns an object (empty default)", () => {
		const result = readMergedSettings();
		expect(typeof result).toBe("object");
	});

	it("does not throw when files are missing", () => {
		const result = readMergedSettings();
		expect(result).toBeDefined();
	});
});
