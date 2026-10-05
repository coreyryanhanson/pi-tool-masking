import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockPI } from "./mock-pi.js";
import {
	defineToolset,
	TOOLSET_EVENTS,
	setDefaultResolutionMode,
	writeToolsetDefaults,
	clearToolsetDefaults,
	clearToolsetEntry,
	clearAllToolsetEntries,
	forceToolsetEnabled,
	isDeferredChild,
	readToolsetDefaults,
} from "../index.js";
import { cleanGlobalKeys, cleanRegistry, REGISTRY_KEY, catchByName, createEnv, reader, useTempSettingsDir } from "./helpers.js";

// Temp settings dirs, file-wide: global settings live in a fresh mkdtemp
// agent dir per test, project settings under a temp cwd — never ~/.pi.
const tmpSettings = useTempSettingsDir();

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
const FOREIGN_PID = String(process.pid + 12345);
const MODE_PERSIST_KEY = "toolset-resolution-mode";

/** Look up a registered toolset handle by spec id (the toggle surface the
 *  library actually exposes). */
function toolsetById(id: string): {
	enable(pi: ExtensionAPI, sm: unknown): unknown;
	disable(pi: ExtensionAPI, sm: unknown): unknown;
} {
	return (globalThis as any)[REGISTRY_KEY].get(id).toolset;
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

/** makeSpec extended with `requires` for cascade rows. */
function makeSpecReq(overrides: {
	id: string;
	persistKey: string;
	names: string[];
	requires: string[];
	defaultEnabled?: boolean;
}) {
	return {
		names: new Set(overrides.names),
		id: overrides.id,
		persistKey: overrides.persistKey,
		requires: overrides.requires,
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

// Process-global state (env var + the globalThis library keys + the once-per-
// process warn-dedup flag) pollutes subsequent cases if left dirty — the
// env-passthrough suite's save/restore discipline, plus a sweep of the
// CHILD_POLICY_WARNED_KEY dedup flag: without it the invalid-value warn
// assertion would be order-dependent rather than testing the warn behavior.
let savedDeferVar: string | undefined;

beforeEach(() => {
	savedDeferVar = process.env[DEFER_ENV];
	cleanRegistry();
});

afterEach(() => {
	if (savedDeferVar === undefined) delete process.env[DEFER_ENV];
	else process.env[DEFER_ENV] = savedDeferVar;
	vi.restoreAllMocks();
	cleanGlobalKeys();
});

// Compose per-scope settings files: optional web pin-off plus the
// childPolicy values, written to the temp global/project settings.json.
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
	if (Object.keys(global).length > 0) {
		tmpSettings.writeJson(tmpSettings.globalSettings, global);
	}
	if (Object.keys(project).length > 0) {
		tmpSettings.writeJson(tmpSettings.projectSettings, project);
	}
}

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

		// Allowlist path: a raw-appended allowlist mode entry (a resumed child
		// branch could carry one) — still a no-op. The seed is a branch
		// entry: the dispatcher's arm source IS the branch:
		// this pins that the defer guard precedes arm selection on the
		// allowlist arm specifically (the exclusion half above covers the
		// other arm).
		mock.appendEntry(MODE_PERSIST_KEY, {
			mode: "allowlist",
			allowlist: [],
		});
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

// ===================================================================
// isDeferredChild — the exported env-only predicate. Consumers gate their
// own actuation paths with this, so its fail-closed contract is pinned
// directly rather than only through the restore/toggle gates.
// ===================================================================

describe("isDeferredChild", () => {
	it("fails closed: absent, empty, and own-pid vars are not deferred; only a foreign pid is", () => {
		delete process.env[DEFER_ENV];
		expect(isDeferredChild()).toBe(false);

		process.env[DEFER_ENV] = "";
		expect(isDeferredChild()).toBe(false);

		process.env[DEFER_ENV] = String(process.pid);
		expect(isDeferredChild()).toBe(false);

		process.env[DEFER_ENV] = FOREIGN_PID;
		expect(isDeferredChild()).toBe(true);
	});
});

// ===================================================================
// Defer gate — toggle boundary. A deferring child enacts no governance:
// implicit ledger/mode writes are silent noops; deliberate write/actuation
// APIs stay live; the gate keys on the foreign var alone (never policy).
// ===================================================================

/** Raw-appended allowlist mode entry — the mode-source mechanism: no
 *  setDefaultResolutionMode call; only the branch carries the governance
 *  entry. */
function seedAllowlistBranch(mock: MockPI): void {
	mock.appendEntry(MODE_PERSIST_KEY, {
		mode: "allowlist",
		allowlist: ["lean.web", "lean.search"],
	});
}

describe("defer gate — toggle boundary", () => {
	it("toggles are silent [] in a deferring child under allowlist — no throw, no cascade, no write, no emit", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.registerTool({ name: "learn-a", description: "" });
		const learn = defineToolset(
			pi,
			makeSpecReq({
				id: "lean.learn",
				persistKey: "toolset-state:lean.learn",
				names: ["learn-a"],
				requires: ["lean.web"],
			}),
		);
		process.env[DEFER_ENV] = FOREIGN_PID;
		seedAllowlistBranch(mock);
		mock.setActiveTools(["web-search", "web-fetch", "search-web", "learn-a"]);
		const beforeTools = mock.getActiveTools();
		const beforeEntries = mock.getEntries();
		const events = collectMaskEvents(mock);

		// The defer gate precedes the mode check — [] rather than a throw.
		expect(learn.enable(pi, reader(pi))).toEqual([]);
		// Also the plain enable/disable of a listed toolset.
		const web = toolsetById("lean.web");
		expect(web.disable(pi, reader(pi))).toEqual([]);
		expect(web.enable(pi, reader(pi))).toEqual([]);

		// Byte-identical everything — including the requires dep: the
		// cascade never ran.
		expect(mock.getActiveTools()).toEqual(beforeTools);
		expect(mock.getEntries()).toEqual(beforeEntries);
		expect(events()).toEqual([]);
	});

	it("setDefaultResolutionMode in a deferring child: validate-then-suppress", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[DEFER_ENV] = FOREIGN_PID;
		const beforeEntries = mock.getEntries();

		// Valid call: the governance authority switch is suppressed — no
		// branch write, no throw.
		setDefaultResolutionMode(pi, "allowlist", ["lean.web"]);
		expect(mock.getEntries()).toEqual(beforeEntries);

		// Input validation survives suppression: invalid mode still throws,
		// branch byte-identical across the throw.
		expect(() => setDefaultResolutionMode(pi, "banana" as any)).toThrow(
			"Invalid defaultResolutionMode",
		);
		expect(() =>
			setDefaultResolutionMode(pi, "allowlist", []),
		).toThrow("non-empty allowlist");
		expect(mock.getEntries()).toEqual(beforeEntries);
	});

	it("clearToolsetEntry and clearAllToolsetEntries noop in a deferring child", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[DEFER_ENV] = FOREIGN_PID;
		// A real prior entry exists — the dedup read would write a tombstone.
		mock.appendEntry("toolset-state:lean.web", { enabled: true });
		const beforeEntries = mock.getEntries();
		const branch = reader(pi).getBranch();

		clearToolsetEntry(pi, "toolset-state:lean.web", branch);
		clearAllToolsetEntries(pi, branch);

		expect(mock.getEntries()).toEqual(beforeEntries);
	});

	it("forceToolsetEnabled stays live in a deferring child — still applies and emits", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[DEFER_ENV] = FOREIGN_PID;
		seedAllowlistBranch(mock);
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		const events = collectMaskEvents(mock);
		const spec = {
			id: "lean.search",
			persistKey: "toolset-state:lean.search",
			names: new Set(["search-web"]),
		};

		forceToolsetEnabled(pi, spec, false);

		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);
		expect(events()).toEqual([{ type: "toolset:changed", id: "lean.search" }]);
	});

	it("settings writers stay live in a deferring child (the deliberate-write carve-out)", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[DEFER_ENV] = FOREIGN_PID;

		writeToolsetDefaults(
			{ "toolset-state:lean.web": { enabled: false } },
			"global",
		);
		expect(readToolsetDefaults("global")).toEqual({
			"toolset-state:lean.web": { enabled: false },
		});

		clearToolsetDefaults("global");
		expect(readToolsetDefaults("global")).toEqual({});
	});

	it("the gate keys on the foreign var alone, never policy: policy settings + foreign var still noops", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ globalPolicy: "settings" });
		process.env[DEFER_ENV] = FOREIGN_PID;
		seedAllowlistBranch(mock);
		const beforeEntries = mock.getEntries();
		const web = toolsetById("lean.web");

		// No restore has run in this process — the var is foreign and the
		// gate is env-only, so the toggle noops even though the (unread)
		// policy says "settings".
		expect(web.disable(pi, reader(pi))).toEqual([]);
		expect(mock.getEntries()).toEqual(beforeEntries);
	});

	it("a defer-publisher parent (own-pid var) still gets enforcing toggles — throws under allowlist", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[DEFER_ENV] = String(process.pid);
		seedAllowlistBranch(mock);
		const web = toolsetById("lean.web");

		expect(catchByName(() => web.enable(pi, reader(pi))).name).toBe(
			"AllowlistModeError",
		);
	});

	it("an empty-string defer var fails closed to enforcing — toggles throw, never silently noop", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[DEFER_ENV] = "";
		seedAllowlistBranch(mock);
		const web = toolsetById("lean.web");

		expect(catchByName(() => web.disable(pi, reader(pi))).name).toBe(
			"AllowlistModeError",
		);
	});

	it("mid-session policy flip to settings: suspension holds between restores; the child's own restore releases it", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		settings({ globalPolicy: "defer" });
		process.env[DEFER_ENV] = FOREIGN_PID;
		seedAllowlistBranch(mock);

		// Restore under defer: skips everything, foreign var untouched.
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		expect(process.env[DEFER_ENV]).toBe(FOREIGN_PID);

		// Flip the policy mid-session: the between-restores window keeps BOTH
		// the re-assert skip and the toggle noop (the gate is env-only).
		settings({ globalPolicy: "settings" });
		const beforeEntries = mock.getEntries();
		const web = toolsetById("lean.web");
		expect(web.enable(pi, reader(pi))).toEqual([]);
		expect(mock.getEntries()).toEqual(beforeEntries);

		// The child's own restore under policy "settings" deletes the var
		// (publish/consume split) and enforces — the toggle now throws.
		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });
		expect(process.env[DEFER_ENV]).toBeUndefined();
		expect(
			catchByName(() => web.enable(pi, reader(pi))).name,
		).toBe("AllowlistModeError");
	});
});
