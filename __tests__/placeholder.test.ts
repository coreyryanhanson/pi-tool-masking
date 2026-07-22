import { describe, it, expect } from "vitest";
import { MockPI } from "./mock-pi.js";
import { defineToolset, TOOLSET_EVENTS } from "../index.js";

describe("pi-tool-masking", () => {
	it("exports compile and types resolve", () => {
		// Verify the public API resolves without type errors
		expect(typeof defineToolset).toBe("function");
		expect(TOOLSET_EVENTS.changed).toBe("toolset:changed");
		expect(TOOLSET_EVENTS.restored).toBe("toolset:restored");
	});

	it("MockPI round-trip: register tools, set active, get active", () => {
		const pi = new MockPI();

		expect(pi.getActiveTools()).toEqual([]);
		expect(pi.getAllTools()).toEqual([]);

		pi.registerTool({ name: "web-search", description: "Search the web" });
		expect(pi.getAllTools()).toHaveLength(1);
		expect(pi.getAllTools()[0]?.name).toBe("web-search");

		pi.setActiveTools(["web-search", "browser-navigate"]);
		expect(pi.getActiveTools()).toEqual(["web-search", "browser-navigate"]);
	});

	it("MockPI appendEntry records writes keyed by customType", () => {
		const pi = new MockPI();

		pi.appendEntry("toolset-state:portal.web", { enabled: true });
		pi.appendEntry("toolset-state:portal.learn", { enabled: false });

		const portalEntries = pi.getEntries("toolset-state:portal.web");
		expect(portalEntries).toHaveLength(1);
		expect(portalEntries[0]?.data).toEqual({ enabled: true });

		expect(pi.getEntries()).toHaveLength(2);
	});

	it("MockPI events bus emits and receives", () => {
		const pi = new MockPI();
		const received: unknown[] = [];

		pi.events.on("toolset:changed", (data) => {
			received.push(data);
		});

		pi.emit("toolset:changed", { id: "portal.web", enabled: true });
		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({ id: "portal.web", enabled: true });
	});

	it("MockPI sessionManager.getBranch returns recorded entries", () => {
		const pi = new MockPI();

		pi.appendEntry("toolset-state:portal.web", { enabled: false });
		const ctx = pi.createContext();

		const branch = ctx.sessionManager.getBranch();
		expect(branch).toHaveLength(1);
		expect(branch[0]).toBeDefined();
		const entry = branch[0] as { customType?: string; data?: unknown };
		expect(entry.customType).toBe("toolset-state:portal.web");
		expect(entry.data).toEqual({ enabled: false });
	});

	it("MockPI has no readEntry", () => {
		const pi = new MockPI() as any;
		expect(pi.readEntry).toBeUndefined();
	});
});
