import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { MockPI } from "./mock-pi.js";
import {
	defineToolset,
	TOOLSET_EVENTS,
	setDefaultResolutionMode,
	readMergedSettings,
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
// §6 Restore handler — persistence round-trip
// ---------------------------------------------------------------------------

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
		ts.disable(pi); // writes { enabled: false }

		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");

		// Tool-a should still be disabled
		expect(mock.getActiveTools()).not.toContain("tool-a");

		// Should have emitted restored (not changed)
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
		ts.enable(pi); // writes { enabled: true }

		mock.fireLifecycleEvent("session_start");

		// Tool-a should be enabled
		expect(mock.getActiveTools()).toContain("tool-a");
	});
});

// ---------------------------------------------------------------------------
// §6 No-entry restore behavior
// ---------------------------------------------------------------------------

describe("Restore — no entry (default fallback, §6, §7.1)", () => {
	it("exclusion mode with defaultEnabled: true → applies on, emits changed", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });

		defineToolset(
			pi,
			makeSpec({
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
		);

		const entryCountBefore = mock.getEntries().length;
		const emitSpy = vi.spyOn(mock.events, "emit");

		mock.fireLifecycleEvent("session_start");

		// Tool should be enabled (exclusion mode default)
		expect(mock.getActiveTools()).toContain("tool-a");

		// Emitted changed (not restored)
		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);

		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		expect(restoredCalls.length).toBe(0);

		// Did NOT call appendEntry
		expect(mock.getEntries().length).toBe(entryCountBefore);
		emitSpy.mockRestore();
	});

	it("exclusion mode with defaultEnabled: false → applies off", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });

		defineToolset(
			pi,
			makeSpec({
				names: new Set(["tool-a"]),
				defaultEnabled: false,
			}),
		);

		mock.fireLifecycleEvent("session_start");

		// Tool should be disabled (defaultEnabled: false under exclusion)
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("inclusion mode → defaults off regardless of defaultEnabled", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });

		setDefaultResolutionMode(pi, "inclusion");
		defineToolset(
			pi,
			makeSpec({
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
		);

		mock.fireLifecycleEvent("session_start");

		// Tool should be off under inclusion mode
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});

	it("inclusion mode emits changed (not restored) and does not persist", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });

		setDefaultResolutionMode(pi, "inclusion");
		defineToolset(
			pi,
			makeSpec({
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
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

// ---------------------------------------------------------------------------
// §6 Always-emit invariant
// ---------------------------------------------------------------------------

describe("Restore — always-emit invariant (§6)", () => {
	it("restore emits one event per registered toolset always", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "t1", description: "" });
		mock.registerTool({ name: "t2", description: "" });

		// Register two toolsets
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

		// Total events: at least 2 (one per toolset)
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
			makeSpec({
				names: new Set(["tool-a"]),
				defaultEnabled: true,
			}),
		);

		// Manually activate tool-a (no appendEntry — no persisted entry)
		mock.setActiveTools(["tool-a"]);

		// Restore: no entry → resolves to defaultEnabled: true (already active)
		// Should still emit changed (always-emit invariant)
		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");

		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		emitSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// §6 Event split: changed vs restored
// ---------------------------------------------------------------------------

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

	// (persisted-entry test removed as redundant — the restored-event-type accuracy
	// is verified by the "restore reads persisted false…" and "restored event payload
	// carries id and enabled" tests below.)

	it("restored event payload carries id and enabled", () => {
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
		ts.enable(pi); // persist

		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");

		const restoredCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.restored,
		);
		const payload = restoredCalls[0]?.[1] as any;
		expect(payload.id).toBe("my.test");
		expect(typeof payload.enabled).toBe("boolean");
		expect(payload.member).toBeUndefined(); // no member on group event
		emitSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// §6 emitMemberEvents
// ---------------------------------------------------------------------------

describe("emitMemberEvents (§6, §13)", () => {
	it("true produces N+1 events on enable (1 group + N members)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });

		const ts = defineToolset(
			pi,
			makeSpec({
				names: new Set(["a", "b"]),
				emitMemberEvents: true,
			}),
		);

		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.enable(pi);

		// 1 group event + 2 member events = 3 total
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
			makeSpec({
				names: new Set(["a", "b"]),
				emitMemberEvents: false,
			}),
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
			makeSpec({
				names: new Set(["a", "b"]),
				emitMemberEvents: true,
			}),
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
			makeSpec({
				names: new Set(["a", "b"]),
				emitMemberEvents: true,
			}),
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
			makeSpec({
				names: new Set(["a", "b"]),
				emitMemberEvents: true,
			}),
		);
		ts.enable(pi);

		const emitSpy = vi.spyOn(mock.events, "emit");
		ts.disable(pi);

		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBe(3); // 1 group + 2 members
		emitSpy.mockRestore();
	});

	it("member events fire on restore (for both changed and restored)", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a", description: "" });
		mock.registerTool({ name: "b", description: "" });

		// A toolset with emitMemberEvents and a persisted entry
		const ts = defineToolset(
			pi,
			makeSpec({
				names: new Set(["a", "b"]),
				emitMemberEvents: true,
			}),
		);
		ts.enable(pi); // persist { enabled: true }

		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start");

		// Should have restored (group + 2 members) = 3 restored events
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

// ---------------------------------------------------------------------------
// §6 Restore idempotent / last-writer-wins
// ---------------------------------------------------------------------------

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

		// Restore never writes appendEntry, so counts should be the same
		expect(entriesAfterSecond).toBe(entriesAfterFirst);
	});

	it("last-writer-wins: most recent entry takes precedence", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });

		const ts = defineToolset(pi, makeSpec({ names: new Set(["tool-a"]) }));
		ts.enable(pi); // { enabled: true }
		ts.disable(pi); // { enabled: false } — most recent

		mock.fireLifecycleEvent("session_start");

		// Should be disabled (last-writer-wins)
		expect(mock.getActiveTools()).not.toContain("tool-a");
	});
});

// ---------------------------------------------------------------------------
// §6 session_tree restore
// ---------------------------------------------------------------------------

describe("Restore — session_tree (§6)", () => {
	it("session_tree also triggers restore", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "tool-a", description: "" });

		defineToolset(
			pi,
			makeSpec({
				names: new Set(["tool-a"]),
				defaultEnabled: false,
			}),
		);

		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_tree");

		const changedCalls = emitSpy.mock.calls.filter(
			([c]) => c === TOOLSET_EVENTS.changed,
		);
		expect(changedCalls.length).toBeGreaterThanOrEqual(1);
		emitSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// §5 readMergedSettings — merge behavior
// ---------------------------------------------------------------------------

describe("readMergedSettings — merge & error handling (§5)", () => {
	let tmpDir: string;
	let homedirSpy: ReturnType<typeof vi.spyOn>;
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ptm-s3-"));

		// Create ~/.pi/agent/settings.json (global)
		const agentDir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				browserToggle: { defaultEnabled: false },
				globalOnly: true,
				shared: "global-val",
			}),
		);

		// Create .pi/settings.json (project) — at the tmpDir root
		fs.writeFileSync(
			path.join(tmpDir, ".pi", "settings.json"),
			JSON.stringify({
				browserToggle: { defaultEnabled: true },
				projectOnly: true,
				shared: "project-val",
			}),
		);

		homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
	});

	afterAll(() => {
		homedirSpy?.mockRestore();
		cwdSpy?.mockRestore();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("merges global and project settings (project wins on conflict)", () => {
		const result = readMergedSettings();
		expect(result.browserToggle).toEqual({ defaultEnabled: true }); // project wins
		expect(result.globalOnly).toBe(true); // from global
		expect(result.projectOnly).toBe(true); // from project
		expect(result.shared).toBe("project-val"); // project wins
	});

	it("returns {} on malformed JSON (project file)", () => {
		// Write bad JSON to project file
		fs.writeFileSync(path.join(tmpDir, ".pi", "settings.json"), "not-json");

		const result = readMergedSettings();
		// With malformed project, should fall back to global
		expect(result.globalOnly).toBe(true);
	});

	it("returns {} when neither file exists", () => {
		// Point to nonexistent dirs
		const badDir = path.join(os.tmpdir(), `ptm-nonexistent-${Date.now()}`);
		const badHomeSpy = vi.spyOn(os, "homedir").mockReturnValue(badDir);
		const badCwdSpy = vi.spyOn(process, "cwd").mockReturnValue(badDir);

		const result = readMergedSettings();
		expect(result).toEqual({});

		badHomeSpy.mockRestore();
		badCwdSpy.mockRestore();
	});

	it("never throws", () => {
		expect(() => readMergedSettings()).not.toThrow();
	});

	it("returns an object (smoke)", () => {
		const result = readMergedSettings();
		expect(typeof result).toBe("object");
	});
});

// ---------------------------------------------------------------------------
// Combined: mode affects restore default but not persisted entry
// ---------------------------------------------------------------------------

describe("Default-resolution mode — entry vs no-entry (§4.5)", () => {
	it("toolset A (with entry) B (no entry): mode affects B but not A", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "a-tool", description: "" });
		mock.registerTool({ name: "b-tool", description: "" });

		// A with entry, B without
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

		// Enable A and persist
		tsA.enable(pi);

		// Switch to inclusion mode
		setDefaultResolutionMode(pi, "inclusion");

		// Restore
		mock.fireLifecycleEvent("session_start");

		// A has an entry (enabled: true) — honored regardless of mode
		expect(mock.getActiveTools()).toContain("a-tool");

		// B has no entry — inclusion mode defaults to off
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
