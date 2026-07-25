import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect } from "vitest";
import { MockPI } from "./mock-pi.js";

// ---------------------------------------------------------------------------
// GlobalThis registry convergence tests (§6.1, §12)
//
// These tests prove the toolset registry lives on globalThis, not in module
// state. They use cache-busting dynamic import queries to simulate isolated
// module loads (jiti re-evaluations, separate extensions) that must share a
// single registry via globalThis.
//
// If someone refactors the registry to module-level state, every test in this
// file must fail.
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

beforeEach(() => {
	cleanRegistry();
});

describe("GlobalThis registry convergence (§6.1, §12)", () => {
	// NOTE: baseline registry tests (initialization, same-Map identity) live
	// in core.test.ts "Registry (§6.1)" — this file covers only the scenarios
	// that require dynamic imports with cache-busting.

	it("two module instances via dynamic import share the same globalThis registry", async () => {
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

		// Second import — different specifier forces Vite to re-evaluate
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
