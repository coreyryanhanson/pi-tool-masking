import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect } from "vitest";
import { MockPI } from "./mock-pi.js";
import { defineToolset } from "../index.js";

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
// §9 invariant: disable uses getActiveTools, not getAllTools
// ---------------------------------------------------------------------------

describe("§9 invariant — disable reads from getActiveTools, not getAllTools", () => {
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

		// Enable A only — B is registered but was never enabled
		tsA.enable(pi);
		expect(mock.getActiveTools()).toEqual(["a"]);

		// getAllTools() = ["a", "b"], getActiveTools() = ["a"]
		// disable using getAllTools would re-add "b" → filter(["a","b"]) = ["b"]
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

// ---------------------------------------------------------------------------
// GlobalThis registry convergence (§6.1, §12)
// ---------------------------------------------------------------------------

describe("GlobalThis registry convergence (§6.1, §12)", () => {
	it("registry is created on globalThis by defineToolset", () => {
		cleanRegistry();
		expect((globalThis as any)[REGISTRY_KEY]).toBeUndefined();

		const { mock, pi } = createEnv();
		mock.registerTool({ name: "t", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "conv.test",
				persistKey: "k:conv",
				names: new Set(["t"]),
			}),
		);

		const reg = (globalThis as any)[REGISTRY_KEY];
		expect(reg).toBeInstanceOf(Map);
		expect(reg.size).toBe(1);
		expect(reg.has("conv.test")).toBe(true);
	});

	it("registry is the same Map across multiple defineToolset calls", () => {
		const { mock: m1, pi: p1 } = createEnv();
		m1.registerTool({ name: "t1", description: "" });
		defineToolset(
			p1,
			makeSpec({ id: "first", persistKey: "k:first", names: new Set(["t1"]) }),
		);

		const regFirst = (globalThis as any)[REGISTRY_KEY];

		const { mock: m2, pi: p2 } = createEnv();
		m2.registerTool({ name: "t2", description: "" });
		defineToolset(
			p2,
			makeSpec({
				id: "second",
				persistKey: "k:second",
				names: new Set(["t2"]),
			}),
		);

		const regSecond = (globalThis as any)[REGISTRY_KEY];
		expect(regSecond).toBe(regFirst);
		expect(regSecond.size).toBe(2);
	});

	it("two module instances via dynamic import share the same globalThis registry", async () => {
		cleanRegistry();

		const mod1 = await import(
			/* @vite-ignore */ `../index.ts?converge-${Date.now()}`
		);

		const { mock: m1, pi: p1 } = createEnv();
		m1.registerTool({ name: "from-mod1", description: "" });
		mod1.defineToolset(p1, {
			id: "mod1.test",
			names: new Set(["from-mod1"]),
			persistKey: "k:mod1.test",
		});

		// Second import — different specifier, fresh evaluation
		const mod2 = await import(
			/* @vite-ignore */ `../index.ts?converge-${Date.now() + 1}`
		);

		// mod2's globalThis sees mod1's toolset without mod2 doing anything
		const { mock: m2, pi: p2 } = createEnv();
		m2.registerTool({ name: "from-mod2", description: "" });

		const registryPre = (globalThis as any)[REGISTRY_KEY] as Map<
			string,
			unknown
		>;
		expect(registryPre.has("mod1.test")).toBe(true);

		// mod2 registers its own toolset — both co-exist
		mod2.defineToolset(p2, {
			id: "mod2.test",
			names: new Set(["from-mod2"]),
			persistKey: "k:mod2.test",
		});

		const registryPost = (globalThis as any)[REGISTRY_KEY] as Map<
			string,
			unknown
		>;
		expect(registryPost.size).toBe(2);
		expect(registryPost.has("mod1.test")).toBe(true);
		expect(registryPost.has("mod2.test")).toBe(true);
	});

	it("toolset defined via one module instance is actionable via another", async () => {
		cleanRegistry();

		const mod1 = await import(
			/* @vite-ignore */ `../index.ts?actionable-${Date.now()}`
		);
		const mod2 = await import(
			/* @vite-ignore */ `../index.ts?actionable-${Date.now() + 1}`
		);

		const { mock: m1, pi: p1 } = createEnv();
		m1.registerTool({ name: "action", description: "" });
		mod1.defineToolset(p1, {
			id: "actionable.test",
			names: new Set(["action"]),
			persistKey: "k:actionable.test",
		});

		// mod2 defines the same id — idempotent, gets same Toolset handle
		const { mock: m2, pi: p2 } = createEnv();
		m2.registerTool({ name: "action", description: "" });

		const ts2 = mod2.defineToolset(p2, {
			id: "actionable.test",
			names: new Set(["action"]),
			persistKey: "k:actionable.test",
		});

		ts2.enable(p2);
		expect(m2.getActiveTools()).toContain("action");

		ts2.disable(p2);
		expect(m2.getActiveTools()).not.toContain("action");
	});
});

// ---------------------------------------------------------------------------
// §5 entry-point smoke
// ---------------------------------------------------------------------------

describe("Entry-point exports (§5)", () => {
	it("all public exports resolve from the package entry", async () => {
		const lib = await import("../index.js");
		expect(typeof lib.defineToolset).toBe("function");
		expect(typeof lib.setDefaultResolutionMode).toBe("function");
		expect(typeof lib.getDefaultResolutionMode).toBe("function");
		expect(typeof lib.readMergedSettings).toBe("function");
		expect(typeof lib.TOOLSET_EVENTS).toBe("object");
		expect(typeof lib.TOOLSET_EVENTS.changed).toBe("string");
		expect(typeof lib.TOOLSET_EVENTS.restored).toBe("string");
	});
});
