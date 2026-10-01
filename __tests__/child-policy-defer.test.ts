import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockPI } from "./mock-pi.js";
import {
	defineToolset,
	TOOLSET_EVENTS,
	setSettingsOverrideForTests,
} from "../index.js";
import { cleanGlobalKeys, cleanRegistry } from "./helpers.js";

// ---------------------------------------------------------------------------
// Child-policy defer — piToolMasking.childPolicy + PI_TOOLMASKING_DEFER
//
// A defer-policy parent publishes PI_TOOLMASKING_DEFER = pid at restore
// (only when the var is absent); a process whose var carries a FOREIGN pid
// defers to its spawner: restore skips everything (settings AND branch
// tiers, no events) and the before_agent_start re-assert is a no-op on both
// dispatch paths. A "settings" policy deletes an inherited var (opt-out is
// subtree-effective) and masks normally.
// ---------------------------------------------------------------------------

const DEFER_ENV = "PI_TOOLMASKING_DEFER";
const MODULE_STATE_KEY = "__piToolMaskingModuleState";
const FOREIGN_PID = String(process.pid + 12345);
const MODE_PERSIST_KEY = "toolset-resolution-mode";

function createEnv(): { mock: MockPI; pi: ExtensionAPI } {
	const mock = new MockPI();
	return { mock, pi: mock as unknown as ExtensionAPI };
}

function makeSpec(overrides: {
	id: string;
	persistKey: string;
	names: string[];
	defaultEnabled?: boolean;
}) {
	return {
		names: new Set(overrides.names),
		id: overrides.id,
		persistKey: overrides.persistKey,
		...(overrides.defaultEnabled === undefined
			? {}
			: { defaultEnabled: overrides.defaultEnabled }),
	};
}

// Standard rig: web (2 tools) + search (1 tool), both packaged defaults ON.
// Tests layer settings pins / branch entries on top as needed.
function setupTwoToolsets(mock: MockPI, pi: ExtensionAPI): void {
	mock.registerTool({ name: "web-search", description: "" });
	mock.registerTool({ name: "web-fetch", description: "" });
	mock.registerTool({ name: "search-web", description: "" });
	defineToolset(
		pi,
		makeSpec({
			id: "lean.web",
			persistKey: "toolset-state:lean.web",
			names: ["web-search", "web-fetch"],
			defaultEnabled: true,
		}),
	);
	defineToolset(
		pi,
		makeSpec({
			id: "lean.search",
			persistKey: "toolset-state:lean.search",
			names: ["search-web"],
			defaultEnabled: true,
		}),
	);
}

// Compose per-scope settings in ONE seam call: optional web pin-off plus the
// childPolicy values. One seam feeds all readers, so pins and policy must be
// set together or the later call silently drops the earlier one.
function settings(
	opts: {
		pinWebOff?: boolean;
		globalPolicy?: unknown;
		projectPolicy?: unknown;
		emptyProjectPiToolMasking?: boolean;
	} = {},
): void {
	const global: Record<string, unknown> = {};
	if (opts.pinWebOff) {
		global["toolsetDefaults"] = {
			"toolset-state:lean.web": { enabled: false },
		};
	}
	if (opts.globalPolicy !== undefined) {
		global["piToolMasking"] = { childPolicy: opts.globalPolicy };
	}
	const project: Record<string, unknown> = {};
	if (opts.projectPolicy !== undefined) {
		project["piToolMasking"] = { childPolicy: opts.projectPolicy };
	} else if (opts.emptyProjectPiToolMasking) {
		project["piToolMasking"] = {};
	}
	setSettingsOverrideForTests({ global, project });
}

function collectMaskEvents(mock: MockPI): () => { type: string; id: string }[] {
	const spy = vi.spyOn(mock.events, "emit");
	return () =>
		spy.mock.calls
			.filter(
				([c]) => c === TOOLSET_EVENTS.restored || c === TOOLSET_EVENTS.changed,
			)
			.map(([c, p]) => ({
				type: c as string,
				id: (p as { id: string }).id,
			}));
}

// Process-global state (env var + globalThis module state + the once-per-
// process warn-dedup flag) pollutes subsequent cases if left dirty — the
// env-passthrough suite's save/restore discipline, plus a sweep of the
// CHILD_POLICY_WARNED_KEY dedup flag: without it the invalid-value warn
// assertion would be order-dependent rather than testing the warn behavior.
let savedDeferVar: string | undefined;

beforeEach(() => {
	savedDeferVar = process.env[DEFER_ENV];
	cleanRegistry();
	setSettingsOverrideForTests({ global: {}, project: {} });
});

afterEach(() => {
	setSettingsOverrideForTests(null);
	if (savedDeferVar === undefined) delete process.env[DEFER_ENV];
	else process.env[DEFER_ENV] = savedDeferVar;
	vi.restoreAllMocks();
	cleanGlobalKeys();
});

// ===================================================================
// Defer at restore
// ===================================================================

describe("defer at restore", () => {
	it("foreign-pid var → restore skips masking; pinned-off toolset stays active; no mask events", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ pinWebOff: true });
		// The spawner activated the child's declared tools; restore must not
		// recompute the mask from settings under defer.
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		process.env[DEFER_ENV] = FOREIGN_PID;
		const events = collectMaskEvents(mock);

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// Settings pin ignored: web tools stay active (spawner owns them).
		expect(mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"search-web",
		]);
		expect(events()).toEqual([]);
	});

	it("deferring child skips the BRANCH tier too — branch entry not applied", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		// Branch entry pinning web off would strip web tools if the branch
		// tier ran; under defer it must not apply.
		mock.appendEntry("toolset-state:lean.web", { enabled: false });
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		process.env[DEFER_ENV] = FOREIGN_PID;

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		expect(mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"search-web",
		]);
	});

	it("deferring child skips the allowlist restore branch — branch mode entry not applied", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		// A resumed child branch could carry an allowlist mode entry; without
		// defer, restore would strip everything outside ["lean.search"]. Under
		// defer the whole restore returns early — spawner's tools survive and
		// no mask events fire.
		mock.appendEntry(MODE_PERSIST_KEY, {
			mode: "allowlist",
			allowlist: ["lean.search"],
		});
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		process.env[DEFER_ENV] = FOREIGN_PID;
		const events = collectMaskEvents(mock);

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		expect(mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"search-web",
		]);
		expect(events()).toEqual([]);
	});
});

// ===================================================================
// Defer at re-assert (before_agent_start)
// ===================================================================

describe("defer at re-assert", () => {
	it("force-added pinned-off tool survives on BOTH dispatch paths", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ pinWebOff: true });
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		process.env[DEFER_ENV] = FOREIGN_PID;
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		expect(mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"search-web",
		]);

		// Disabled path: a foreign reconciler force-adds a pinned-off tool.
		mock.setActiveTools(["search-web", "web-search"]);
		mock.fireLifecycleEvent("before_agent_start", {
			type: "before_agent_start",
		});
		expect(mock.getActiveTools()).toEqual(["search-web", "web-search"]);

		// Allowlist path: seed module state as if an allowlist mask were
		// active (a resumed child branch could carry one) — still a no-op.
		(globalThis as any)[MODULE_STATE_KEY] = {
			defaultResolutionMode: "allowlist",
			activeAllowlist: [],
		};
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		mock.fireLifecycleEvent("before_agent_start", {
			type: "before_agent_start",
		});
		expect(mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"search-web",
		]);
	});
});

// ===================================================================
// Publish + policy resolution
// ===================================================================

describe("publish + policy", () => {
	it("self-pid var is NOT foreign — masking applies normally (parent behavior)", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ pinWebOff: true });
		process.env[DEFER_ENV] = String(process.pid);

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		expect(mock.getActiveTools()).toEqual(["search-web"]);
	});

	it("childPolicy 'defer' publishes own pid", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ globalPolicy: "defer" });

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		expect(process.env[DEFER_ENV]).toBe(String(process.pid));
	});

	it("empty-string var is garbage, not a foreign defer tag — publishes own pid and enforces", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ pinWebOff: true });
		// Empty var: no producer writes it, so it must NOT be treated as a
		// foreign defer tag (silent permanent defer). Publish over it and mask.
		process.env[DEFER_ENV] = "";
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		expect(process.env[DEFER_ENV]).toBe(String(process.pid));
		// web pinned off by settings, search stays on (packaged default).
		expect(mock.getActiveTools()).toEqual(["search-web"]);
	});

	it("default (key absent) is defer — publishes; a foreign var defers", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		expect(process.env[DEFER_ENV]).toBe(String(process.pid));

		// Fresh rig with a foreign var: default-defer child defers.
		cleanGlobalKeys();
		const child = createEnv();
		setupTwoToolsets(child.mock, child.pi);
		settings({ pinWebOff: true });
		child.mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		process.env[DEFER_ENV] = FOREIGN_PID;
		child.mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		expect(child.mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"search-web",
		]);
	});

	it("opt-out ('settings') with var present — var deleted, masking applies, nothing republished", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ pinWebOff: true, globalPolicy: "settings" });
		process.env[DEFER_ENV] = FOREIGN_PID;

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// Masking applies and the var propagation stops here. A default-defer
		// grandchild would publish its own var — the opt-out does not silence
		// deferral further below.
		expect(process.env[DEFER_ENV]).toBeUndefined();
		expect(mock.getActiveTools()).toEqual(["search-web"]);
	});

	it("invalid value warns once (deduped) and is treated as 'defer'", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ globalPolicy: "banana" });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("childPolicy"));
		expect(process.env[DEFER_ENV]).toBe(String(process.pid));

		// Deduped: a second restore does not re-warn.
		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it("invalid PROJECT value falls through to a valid global policy", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({
			pinWebOff: true,
			globalPolicy: "settings",
			projectPolicy: "banana",
		});
		process.env[DEFER_ENV] = FOREIGN_PID;
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// The project typo is treated as absent → global "settings" wins:
		// var deleted, masking applies.
		expect(process.env[DEFER_ENV]).toBeUndefined();
		expect(mock.getActiveTools()).toEqual(["search-web"]);
	});

	it("allowlist-mode parent publishes BEFORE the allowlist short-circuit returns", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.appendEntry(MODE_PERSIST_KEY, {
			mode: "allowlist",
			allowlist: ["lean.search"],
		});
		settings({ globalPolicy: "defer" });

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// Regression for the placement rule: the short-circuit branch returns
		// before the per-toolset loop, but the publish (and policy read) sit
		// above it — var published AND allowlist mask applied.
		expect(process.env[DEFER_ENV]).toBe(String(process.pid));
		expect(mock.getActiveTools()).toEqual(["search-web"]);
	});

	it("project 'defer' overrides global 'settings' — foreign-var child defers", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({
			pinWebOff: true,
			globalPolicy: "settings",
			projectPolicy: "defer",
		});
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		process.env[DEFER_ENV] = FOREIGN_PID;

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// Project wins per scope (scalar, no spread-merge): defer → var left
		// untouched, pins not enforced.
		expect(process.env[DEFER_ENV]).toBe(FOREIGN_PID);
		expect(mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"search-web",
		]);
	});

	it("project 'piToolMasking: {}' does NOT drop the global childPolicy (no spread-merge)", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({
			pinWebOff: true,
			globalPolicy: "settings",
			emptyProjectPiToolMasking: true,
		});

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// Global "settings" survives the empty project object → opt-out holds.
		expect(process.env[DEFER_ENV]).toBeUndefined();
		expect(mock.getActiveTools()).toEqual(["search-web"]);
	});

	it("project 'settings' overrides global 'defer' — masking applies, var deleted", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({
			pinWebOff: true,
			globalPolicy: "defer",
			projectPolicy: "settings",
		});
		process.env[DEFER_ENV] = FOREIGN_PID;

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		expect(process.env[DEFER_ENV]).toBeUndefined();
		expect(mock.getActiveTools()).toEqual(["search-web"]);
	});
});

// ===================================================================
// Var passthrough (foreign var left untouched)
// ===================================================================

describe("var passthrough", () => {
	it("deferring child leaves a foreign var untouched (grandchildren inherit it)", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[DEFER_ENV] = FOREIGN_PID;

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// Still the parent's pid — no republish, no delete.
		expect(process.env[DEFER_ENV]).toBe(FOREIGN_PID);
	});

	it("second restore (session_tree) still defers, still no events, var untouched", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[DEFER_ENV] = FOREIGN_PID;
		const events = collectMaskEvents(mock);

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });

		// A republish would write our own pid and flip the child to enforcing
		// at its next restore — the exact republish trap.
		expect(process.env[DEFER_ENV]).toBe(FOREIGN_PID);
		expect(events()).toEqual([]);
	});
});
