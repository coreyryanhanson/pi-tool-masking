import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockPI } from "./mock-pi.js";
import {
	defineToolset,
	TOOLSET_EVENTS,
	setSettingsOverrideForTests,
} from "../index.js";

// ---------------------------------------------------------------------------
// Env passthrough — ephemeral live-state mirror for subagent children
//
// Parent publishes `{ v: 1, pid, boot, state }` into
// PI_TOOLMASKING_LIVE_STATE on tool_call + session_start/session_tree; a
// fresh child consumes it at restore (read-and-delete) as a tier above
// settings defaults.
// ---------------------------------------------------------------------------

const LIVE_STATE_ENV = "PI_TOOLMASKING_LIVE_STATE";
const NO_INHERIT_ENV = "PI_TOOLMASKING_NO_INHERIT";
const REGISTRY_KEY = "__piToolMaskingRegistry";
const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";
const MODULE_STATE_KEY = "__piToolMaskingModuleState";
const BOOT_ID_KEY = "__piToolMaskingBootId";

function createEnv(): { mock: MockPI; pi: ExtensionAPI } {
	const mock = new MockPI();
	return { mock, pi: mock as unknown as ExtensionAPI };
}

function cleanGlobalState(): void {
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[RESTORE_EVENT_KEY];
	delete (globalThis as any)[MODULE_STATE_KEY];
	delete (globalThis as any)[BOOT_ID_KEY];
}

function makeEnvelope(state: Record<string, { enabled: boolean }>): string {
	return JSON.stringify({
		v: 1,
		pid: process.pid + 12345, // foreign pid — genuine inheritance
		boot: "foreign-boot-id",
		state,
	});
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

// Process-global tier (env vars + globalThis module state) pollutes
// subsequent cases if left dirty — the most likely source of suite flakiness.
let savedLiveState: string | undefined;
let savedNoInherit: string | undefined;

beforeEach(() => {
	cleanGlobalState();
	setSettingsOverrideForTests({});
	savedLiveState = process.env[LIVE_STATE_ENV];
	savedNoInherit = process.env[NO_INHERIT_ENV];
	delete process.env[LIVE_STATE_ENV];
	delete process.env[NO_INHERIT_ENV];
});

afterEach(() => {
	setSettingsOverrideForTests(null);
	if (savedLiveState === undefined) delete process.env[LIVE_STATE_ENV];
	else process.env[LIVE_STATE_ENV] = savedLiveState;
	if (savedNoInherit === undefined) delete process.env[NO_INHERIT_ENV];
	else process.env[NO_INHERIT_ENV] = savedNoInherit;
	vi.restoreAllMocks();
	cleanGlobalState();
});

// Standard two-toolset rig: both packaged defaults ON; tests layer settings
// pins, mirrors, and branch entries on top as needed.
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

// ===================================================================
// Publish
// ===================================================================

describe("publish", () => {
	it("publishes on session_start with own pid and post-restore state", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.setActiveTools(["web-search", "web-fetch"]);
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		const raw = process.env[LIVE_STATE_ENV];
		expect(raw).toBeDefined();
		const env = JSON.parse(raw!) as {
			v: number;
			pid: number;
			boot: string;
			state: Record<string, { enabled: boolean }>;
		};
		expect(env.v).toBe(1);
		expect(env.pid).toBe(process.pid);
		expect(typeof env.boot).toBe("string");
		// Publish runs at the BOTTOM of doRestore — it snapshots POST-restore
		// state, which includes the packaged-default restore of search (on).
		expect(env.state).toEqual({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: true },
		});
	});

	it("publishes on every tool_call (publish-always) — no dirty flag", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.setActiveTools(["web-search", "web-fetch"]);
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// A second publish with unchanged state keeps the identical string.
		const before = process.env[LIVE_STATE_ENV];
		mock.dispatchToolCall();
		expect(process.env[LIVE_STATE_ENV]).toBe(before);

		// Toggle changes the snapshot → next tool_call rewrites.
		mock.setActiveTools([]);
		mock.dispatchToolCall();
		expect(JSON.parse(process.env[LIVE_STATE_ENV]!)).toMatchObject({
			state: {
				"toolset-state:lean.web": { enabled: false },
				"toolset-state:lean.search": { enabled: false },
			},
		});
	});

	it("delta-gates against the live env value: rewrite after identity-guard deletion", () => {
		// The consumer deletes the var (session_tree //new identity guard);
		// the next tool_call must rewrite even though no toggle happened —
		// a held-last-string gate would skip it and orphan the mirror.
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.setActiveTools(["web-search", "web-fetch"]);
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		const published = process.env[LIVE_STATE_ENV]!;
		delete process.env[LIVE_STATE_ENV];

		mock.dispatchToolCall();
		expect(process.env[LIVE_STATE_ENV]).toBe(published);
	});

	it("late defineToolset registration appears in the next tool_call snapshot", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.setActiveTools(["web-search", "web-fetch"]);
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		expect(process.env[LIVE_STATE_ENV]).not.toContain("toolset-state:lean.late");

		// Lazy registration — no toggle, no flag; the next dispatch picks it up.
		mock.registerTool({ name: "late-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "lean.late",
				persistKey: "toolset-state:lean.late",
				names: ["late-tool"],
			}),
		);
		mock.setActiveTools(["web-search", "web-fetch", "late-tool"]);
		mock.dispatchToolCall();

		expect(JSON.parse(process.env[LIVE_STATE_ENV]!).state).toMatchObject({
			"toolset-state:lean.late": { enabled: true },
		});
	});

	it("registered-members predicate: unregistered member doesn't force off; zero-registered toolset publishes no key", () => {
		const { mock, pi } = createEnv();
		// lean.web has one registered + one unregistered member; lean.ghost
		// has none.
		mock.registerTool({ name: "web-search", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "lean.web",
				persistKey: "toolset-state:lean.web",
				names: ["web-search", "web-never-registered"],
			}),
		);
		defineToolset(
			pi,
			makeSpec({
				id: "lean.ghost",
				persistKey: "toolset-state:lean.ghost",
				names: ["never-registered-a", "never-registered-b"],
			}),
		);
		mock.setActiveTools(["web-search"]);
		mock.dispatchToolCall();

		const state = JSON.parse(process.env[LIVE_STATE_ENV]!).state;
		expect(state).toEqual({ "toolset-state:lean.web": { enabled: true } });
	});

	it("empty snapshot (no registered members at all) publishes nothing", () => {
		const { mock, pi } = createEnv();
		// Toolsets whose spec.names filter to zero registered tools — the
		// vacuous-truth guard keeps their keys out, so the state map is empty.
		defineToolset(
			pi,
			makeSpec({
				id: "lean.ghost",
				persistKey: "toolset-state:lean.ghost",
				names: ["never-registered-a"],
			}),
		);
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		mock.dispatchToolCall();
		expect(process.env[LIVE_STATE_ENV]).toBeUndefined();
	});

	it("publishes on session_tree and session_shutdown deletes the mirror", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.setActiveTools(["web-search", "web-fetch"]);

		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });
		expect(process.env[LIVE_STATE_ENV]).toBeDefined();

		mock.fireLifecycleEvent("session_shutdown", {
			type: "session_shutdown",
			reason: "quit",
		});
		expect(process.env[LIVE_STATE_ENV]).toBeUndefined();
	});

	it("handler hygiene: tool_call and session_shutdown install exactly once", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.registerTool({ name: "more-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "lean.more",
				persistKey: "toolset-state:lean.more",
				names: ["more-tool"],
			}),
		);
		expect(mock.handlerCount("tool_call")).toBe(1);
		expect(mock.handlerCount("session_shutdown")).toBe(1);
	});
});

// ===================================================================
// Consume + precedence
// ===================================================================

describe("consume and precedence", () => {
	it("fresh child consumes mirror over settings defaults; foreign envelope does not survive", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		// Settings pin web off — the foreign mirror (web on) must outrank it.
		setSettingsOverrideForTests({
			"toolset-state:lean.web": { enabled: false },
		});
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: false },
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);
		// The channel is auditable: one consumption log naming the source pid.
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				`[pi-tool-masking] Inherited toolset state from pid ${process.pid + 12345}`,
			),
		);
		logSpy.mockRestore();
		// The var is consumed at the top of doRestore, then RE-published at the
		// bottom with the child's own identity (post-restore state) — so it is
		// not absent, but it no longer carries the foreign envelope.
		const republished = JSON.parse(process.env[LIVE_STATE_ENV]!) as {
			pid: number;
			boot: string;
		};
		expect(republished.pid).toBe(process.pid);
		expect(republished.boot).toBe((globalThis as any)[BOOT_ID_KEY]);

		// Grandchild: a genuinely new process inherits the CHILD's republished
		// (post-restore) state — not the parent's raw envelope. Simulate the new
		// process in-process: wipe module state (fresh process state) and re-tag
		// the standing var with a foreign pid (the child's pid is foreign to the
		// grandchild's process).
		delete (globalThis as any)[MODULE_STATE_KEY];
		process.env[LIVE_STATE_ENV] = process.env[LIVE_STATE_ENV]!.replace(
			`"pid":${process.pid},`,
			`"pid":${process.pid + 1},`,
		);
		const { mock: grandchild, pi: gpi } = createEnv();
		setupTwoToolsets(grandchild, gpi);
		grandchild.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		// The child resolved web on (mirror) and search off (mirror) — the
		// grandchild inherits that resolved state over the same pin-off.
		expect(grandchild.getActiveTools()).toEqual(["web-search", "web-fetch"]);
	});

	it("branch entry beats mirror (fork replays parent entries)", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		// Fork child replays the parent's branch entry pinning web OFF, over
		// a mirror that says ON.
		mock.appendEntry("toolset-state:lean.web", { enabled: false });
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: false },
		});

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "fork",
		});
		// Branch pins web off; mirror pins search off — nothing survives.
		expect(mock.getActiveTools()).toEqual([]);
	});

	it("mirror beats settings pin; partial map resolves both directions", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		setSettingsOverrideForTests({
			"toolset-state:lean.web": { enabled: false },
			"toolset-state:lean.search": { enabled: true },
		});
		// Mirror: web on (overrides pin-off), search off (overrides pin-on);
		// no entry for lean.late → settings resolve for it.
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: false },
		});
		mock.registerTool({ name: "late-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "lean.late",
				persistKey: "toolset-state:lean.late",
				names: ["late-tool"],
			}),
		);

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		// Mirror overrides both pins; lean.late has no mirror entry → packaged
		// default (on) resolves.
		expect(mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"late-tool",
		]);
	});

	it("mirror-resolved restore emits restored, not changed", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: false },
		});

		const emitSpy = vi.spyOn(mock.events, "emit");
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		const events = emitSpy.mock.calls
			.filter(
				([c]) => c === TOOLSET_EVENTS.restored || c === TOOLSET_EVENTS.changed,
			)
			.map(([c, p]) => ({ type: c, id: (p as { id: string }).id }));
		expect(events).toContainEqual({
			type: TOOLSET_EVENTS.restored,
			id: "lean.web",
		});
		expect(events).toContainEqual({
			type: TOOLSET_EVENTS.restored,
			id: "lean.search",
		});
		expect(events.filter((e) => e.type === TOOLSET_EVENTS.changed)).toEqual([]);
		emitSpy.mockRestore();
	});

	it("malformed entries (non-boolean enabled) are inert; valid entries still apply", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[LIVE_STATE_ENV] = JSON.stringify({
			v: 1,
			pid: process.pid + 1,
			boot: "foreign",
			state: {
				// enabled: "yes" is not a boolean → falls through to settings
				"toolset-state:lean.web": { enabled: "yes" },
				"toolset-state:lean.search": { enabled: false },
			},
		});
		setSettingsOverrideForTests({
			"toolset-state:lean.web": { enabled: true },
		});

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		// web: mirror entry inert → settings pin on. search: mirror off applies.
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);
	});
});

// ===================================================================
// Fail-closed
// ===================================================================

describe("fail-closed", () => {
	it("corrupt JSON, bad shape, unknown version, and >64KB all: settings resolve, var deleted, one log line", () => {
		const cases: [string, string][] = [
			["corrupt JSON", "{not json"],
			["bad envelope shape", JSON.stringify({ hello: true })],
			[
				"unknown version",
				JSON.stringify({
					v: 2,
					pid: 1,
					boot: "b",
					state: { "toolset-state:lean.web": { enabled: true } },
				}),
			],
			["oversized", `{"v":1,"pid":1,"boot":"b","state":"${"x".repeat(70_000)}"}`],
		];
		for (const [, raw] of cases) {
			const { mock, pi } = createEnv();
			setupTwoToolsets(mock, pi);
			const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			process.env[LIVE_STATE_ENV] = raw;
			setSettingsOverrideForTests({
				"toolset-state:lean.web": { enabled: true },
			});

			mock.fireLifecycleEvent("session_start", {
				type: "session_start",
				reason: "startup",
			});

			// Settings resolved (web pin on + search packaged on), one warn line,
			// and the malformed payload is gone (fail-closed consumed it; the
			// post-restore publish rewrote it with our own identity).
			expect(mock.getActiveTools()).toEqual([
				"web-search",
				"web-fetch",
				"search-web",
			]);
			const republished = JSON.parse(process.env[LIVE_STATE_ENV]!) as {
				pid: number;
			};
			expect(republished.pid).toBe(process.pid);
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					"[pi-tool-masking] Ignoring PI_TOOLMASKING_LIVE_STATE",
				),
			);
			logSpy.mockRestore();
		}
	});
});

// ===================================================================
// Identity guard
// ===================================================================

describe("identity guard", () => {
	it("mirror tagged with own pid+boot is a stale self-mirror: deleted, ignored, settings resolve", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		// Parent published, then /new: same process, mirror left standing.
		mock.setActiveTools(["web-search", "web-fetch"]);
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		// The standing mirror carries OUR pid+boot. A fresh resolution (new
		// session) must not consume it.
		setSettingsOverrideForTests({
			"toolset-state:lean.web": { enabled: false },
		});
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "new",
		});
		// Map cleared → settings resolve: web pin off, search packaged on.
		expect(mock.getActiveTools()).toEqual(["search-web"]);
		expect(process.env[LIVE_STATE_ENV]).toBeDefined(); // republished own-pid
	});

	it("boot id survives module re-eval (/reload) — stale self-mirror still ignored", () => {
		// /reload re-evals the module in the same process: registry + module
		// state reset, but BOOT_ID_KEY (on globalThis) survives. The standing
		// self-mirror carries the OLD boot + same pid — the guard must still
		// match it. A module-local boot would regenerate and misconsume.
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		mock.setActiveTools(["web-search", "web-fetch"]);
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		const bootBefore = (globalThis as any)[BOOT_ID_KEY];
		expect(typeof bootBefore).toBe("string");

		// Simulate /reload: fresh module state + registry, same process, same
		// boot id, standing self-mirror still in env.
		delete (globalThis as any)[REGISTRY_KEY];
		delete (globalThis as any)[RESTORE_EVENT_KEY];
		delete (globalThis as any)[MODULE_STATE_KEY];
		setSettingsOverrideForTests({
			"toolset-state:lean.web": { enabled: false },
		});
		const reloaded = createEnv();
		setupTwoToolsets(reloaded.mock, reloaded.pi);
		expect((globalThis as any)[BOOT_ID_KEY]).toBe(bootBefore);

		reloaded.mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "reload",
		});
		// Self-mirror consumed as NOTHING: settings pin (web off) resolves;
		// search falls back to its packaged default (on).
		expect(reloaded.mock.getActiveTools()).toEqual(["search-web"]);
		expect(process.env[LIVE_STATE_ENV]).toBeDefined(); // republished post-restore
	});
});

// ===================================================================
// Held-map lifecycle (consumed map in module state)
// ===================================================================

describe("held-map lifecycle", () => {
	function consumeOnce(mock: MockPI): void {
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: false },
		});
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
	}

	it("held map survives session_tree (inheritance not dropped on tree navigation)", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		consumeOnce(mock);
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);

		// Tree navigation re-restores — the var is gone, the held map persists.
		setSettingsOverrideForTests({
			"toolset-state:lean.web": { enabled: false },
		});
		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);
	});

	it("held map cleared on same-process session switch (new, resume) — kept on reload", () => {
		for (const reason of ["new", "resume"]) {
			const { mock, pi } = createEnv();
			setupTwoToolsets(mock, pi);
			consumeOnce(mock);
			expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);

			// A same-process switch means fresh resolution: settings pin wins.
			setSettingsOverrideForTests({
				"toolset-state:lean.web": { enabled: false },
			});
			mock.fireLifecycleEvent("session_start", {
				type: "session_start",
				reason,
			});
			// Map cleared → settings resolve: web pin off, search packaged on.
			expect(mock.getActiveTools()).toEqual(["search-web"]);
		}

		// "reload" is the verified same-session exception: map kept.
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		consumeOnce(mock);
		setSettingsOverrideForTests({
			"toolset-state:lean.web": { enabled: false },
		});
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "reload",
		});
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);
	});

	it("held map resolves a toolset registered after consumption (resolution-time lookup)", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		// Mirror carries a key for a toolset the child hasn't registered yet.
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.late": { enabled: true },
		});
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// Late plugin load / lazy defineToolset AFTER session_start.
		mock.registerTool({ name: "late-tool", description: "" });
		defineToolset(
			pi,
			makeSpec({
				id: "lean.late",
				persistKey: "toolset-state:lean.late",
				names: ["late-tool"],
			}),
		);
		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });
		expect(mock.getActiveTools()).toContain("late-tool");
	});

	it("allowlist-mode branch: held map inert while mode is allowlist, revives when mode flips back", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		consumeOnce(mock);
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);

		// Switch to allowlist mode (search only): the short-circuit is
		// authoritative — the held mirror must not re-add web.
		mock.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: ["lean.search"],
		});
		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });
		expect(mock.getActiveTools()).toEqual(["search-web"]);

		// Flip back to exclusion: the held mirror revives (web on, search off).
		mock.appendEntry("toolset-resolution-mode", { mode: "exclusion" });
		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);
	});

	it("fresh child of an allowlist-mode parent: no branch, mode exclusion, mirror resolves (consume-before-short-circuit)", () => {
		// The sharp case for consume placement: an allowlist-mode PARENT spawns
		// a fresh child. The child's restore resolves mode from its own (empty)
		// branch → exclusion — but the consume must already have happened. If
		// consume ran after mode resolution on an allowlist child, it would
		// never see the mirror. Here the child's branch carries an allowlist
		// entry whose member is registered — the short-circuit path runs — and
		// the mirror key for a toolset OUTSIDE the allowlist must still have
		// been consumed (held map survives), reviving if mode flips back.
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: true },
		});
		mock.appendEntry("toolset-resolution-mode", {
			mode: "allowlist",
			allowlist: ["lean.search"],
		});
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		expect(process.env[LIVE_STATE_ENV]).toBeDefined(); // consumed, republished own-pid
		const republished = JSON.parse(process.env[LIVE_STATE_ENV]!) as {
			pid: number;
		};
		expect(republished.pid).toBe(process.pid);
		expect(mock.getActiveTools()).toEqual(["search-web"]);

		mock.appendEntry("toolset-resolution-mode", { mode: "exclusion" });
		mock.fireLifecycleEvent("session_tree", { type: "session_tree" });
		// Held mirror (both on) beats the settings-less exclusion floor.
		expect([...mock.getActiveTools()].sort()).toEqual(
			["web-fetch", "web-search", "search-web"].sort(),
		);
	});
});

// ===================================================================
// Re-assert (before_agent_start)
// ===================================================================

describe("re-assert", () => {
	it("child's first before_agent_start does NOT strip inherited tools", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		setSettingsOverrideForTests({
			"toolset-state:lean.web": { enabled: false },
		});
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: false },
		});
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);

		// First turn: the consumed map must be visible to the re-assert, or
		// settings defaults (web off) would strip the inherited mask here.
		mock.fireLifecycleEvent("before_agent_start", {
			type: "before_agent_start",
		});
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);
	});

	it("re-assert removes force-added tools of a mirror-disabled toolset", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
			"toolset-state:lean.search": { enabled: false },
		});
		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// A foreign reconciler force-adds a search tool mid-session.
		mock.setActiveTools(["web-search", "web-fetch", "search-web"]);
		mock.fireLifecycleEvent("before_agent_start", {
			type: "before_agent_start",
		});
		expect(mock.getActiveTools()).toEqual(["web-search", "web-fetch"]);
	});
});

// ===================================================================
// Opt-out (PI_TOOLMASKING_NO_INHERIT)
// ===================================================================

describe("opt-out", () => {
	it("PI_TOOLMASKING_NO_INHERIT: mirror tier skipped, settings resolve, var deleted, opt-out var propagates", () => {
		const { mock, pi } = createEnv();
		setupTwoToolsets(mock, pi);
		process.env[LIVE_STATE_ENV] = makeEnvelope({
			"toolset-state:lean.web": { enabled: true },
		});
		process.env[NO_INHERIT_ENV] = "1";
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		mock.fireLifecycleEvent("session_start", {
			type: "session_start",
			reason: "startup",
		});

		// Settings/packaged defaults resolve (no inheritance): both packaged
		// defaults are on → all three tools active.
		expect(mock.getActiveTools()).toEqual([
			"web-search",
			"web-fetch",
			"search-web",
		]);
		// The var is consumed at the top, then RE-published at the bottom with
		// the child's own identity (publish runs on every doRestore exit; the
		// NO_INHERIT child still publishes its own resolved state).
		const republished = JSON.parse(process.env[LIVE_STATE_ENV]!) as {
			pid: number;
		};
		expect(republished.pid).toBe(process.pid);
		// ...but the opt-out var itself is never deleted (propagates to
		// grandchildren by design).
		expect(process.env[NO_INHERIT_ENV]).toBe("1");
		// No consumption log (the mirror tier was skipped entirely).
		expect(logSpy).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});
});
