import { describe, it, expect, beforeEach } from "vitest";
import {
	computeDrift,
	defineToolset,
	forceToolsetEnabled,
	getActuatableNames,
	setDefaultResolutionMode,
} from "../index.js";
import { MockPI } from "./mock-pi.js";
import { cleanRegistry, createEnv, useTempSettingsDir } from "./helpers.js";

// computeDrift reads the merged settings defaults on every call, so the
// real ~/.pi must never be in play.
const settings = useTempSettingsDir();

const DEFER_ENV = "PI_TOOLMASKING_DEFER";

function makeSpec(
	overrides: Partial<{
		id: string;
		persistKey: string;
		names: Set<string>;
		defaultEnabled: boolean;
	}> = {},
) {
	return {
		id: "test.web",
		names: new Set(["web-a", "web-b", "web-c"]),
		persistKey: "toolset-state:test.web",
		...overrides,
	};
}

describe("getActuatableNames", () => {
	beforeEach(() => cleanRegistry());

	it("excludes hidden-exposure members", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "visible", description: "" });
		mock.registerTool({ name: "veiled", description: "", exposure: "hidden" });
		const names = getActuatableNames(pi);
		expect(names.has("visible")).toBe(true);
		expect(names.has("veiled")).toBe(false);
	});

	it("includes every non-hidden tool, including tools outside any toolset", () => {
		const { mock, pi } = createEnv();
		// No toolset is defined at all: the filter scans getAllTools(), it does
		// not intersect with spec.names (the predicate does that).
		mock.registerTool({ name: "loose-tool", description: "" });
		mock.registerTool({ name: "loose-hidden", description: "", exposure: "hidden" });
		const names = getActuatableNames(pi);
		expect(names.has("loose-tool")).toBe(true);
		expect(names.has("loose-hidden")).toBe(false);
	});
});

describe("computeDrift", () => {
	beforeEach(() => {
		cleanRegistry();
	});

	function branchOf(mock: MockPI) {
		return mock.branchReader().getBranch();
	}

	it("flags a leak: intent off, member active", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "" });
		mock.registerTool({ name: "web-b", description: "" });
		const spec = makeSpec({
			names: new Set(["web-a", "web-b"]),
			defaultEnabled: false,
		});
		defineToolset(pi, spec);
		mock.setActiveTools(["web-a"]);
		const drift = computeDrift(pi, branchOf(mock));
		expect(drift).toHaveLength(1);
		expect(drift[0]!.id).toBe("test.web");
		// Fact-string format is pinned here — it wins over any consumer's copy.
		expect(drift[0]!.fact).toBe("test.web (intent off, 1 active)");
	});

	it("flags force-removal under intent on, including the all-members-removed clobber", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "" });
		mock.registerTool({ name: "web-b", description: "" });
		mock.registerTool({ name: "web-c", description: "" });
		const spec = makeSpec();
		defineToolset(pi, spec);
		forceToolsetEnabled(pi, spec, true);
		// A foreign full-loadout write omitted the toolset entirely: clobber.
		mock.setActiveTools(["other-tool"]);
		const drift = computeDrift(pi, branchOf(mock));
		expect(drift).toEqual([
			{ id: "test.web", fact: "test.web (intent on, 0 of 3 active)" },
		]);

		// Partial repair: one member restored, two still missing.
		mock.setActiveTools(["other-tool", "web-a"]);
		expect(computeDrift(pi, branchOf(mock))).toEqual([
			{ id: "test.web", fact: "test.web (intent on, 1 of 3 active)" },
		]);
	});

	it("an inert toolset (zero actuatable members) does not flag", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "", exposure: "hidden" });
		const spec = makeSpec({ names: new Set(["web-a"]) });
		defineToolset(pi, spec);
		forceToolsetEnabled(pi, spec, true);
		// Intent on, nothing active: the MCP-server-not-connected case — the
		// command that could fix it does not exist, so it must not alarm.
		expect(computeDrift(pi, branchOf(mock))).toEqual([]);
	});

	it("a partially-registered toolset does not flag on a legitimate partial count", () => {
		const { mock, pi } = createEnv();
		// spec governs three names, but only two are registered right now.
		mock.registerTool({ name: "web-a", description: "" });
		mock.registerTool({ name: "web-b", description: "" });
		const spec = makeSpec();
		defineToolset(pi, spec);
		forceToolsetEnabled(pi, spec, true);
		mock.setActiveTools(["web-a", "web-b"]);
		expect(computeDrift(pi, branchOf(mock))).toEqual([]);
	});

	it("a hidden member is excluded from both sides of the comparison", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "" });
		mock.registerTool({ name: "web-b", description: "", exposure: "hidden" });
		const spec = makeSpec({ names: new Set(["web-a", "web-b"]) });
		defineToolset(pi, spec);
		forceToolsetEnabled(pi, spec, true);
		// The hidden member is not in the active set, but it is also not in
		// `expected` — no false force-removal alarm.
		mock.setActiveTools(["web-a"]);
		expect(computeDrift(pi, branchOf(mock))).toEqual([]);
	});

	it("a defaultActive: false member flags when deactivated under intent-on, not once converged", () => {
		const { mock, pi } = createEnv();
		// The extension API carries no defaultActive, so the test registers
		// the member normally and deactivates it via setActiveTools — the
		// state the predicate classifies, not the mechanism.
		mock.registerTool({ name: "web-a", description: "" });
		mock.registerTool({ name: "web-b", description: "" });
		const spec = makeSpec({ names: new Set(["web-a", "web-b"]) });
		defineToolset(pi, spec);
		forceToolsetEnabled(pi, spec, true);
		mock.setActiveTools(["web-a", "web-b"]);
		expect(computeDrift(pi, branchOf(mock))).toEqual([]);
		mock.setActiveTools(["web-b"]);
		expect(computeDrift(pi, branchOf(mock))).toEqual([
			{ id: "test.web", fact: "test.web (intent on, 1 of 2 active)" },
		]);
	});

	it("a clean toolset does not flag, and only mismatched ids are returned", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "clean-a", description: "" });
		mock.registerTool({ name: "leak-x", description: "" });
		const clean = makeSpec({
			id: "test.clean",
			persistKey: "toolset-state:test.clean",
			names: new Set(["clean-a"]),
			defaultEnabled: true,
		});
		const leaky = makeSpec({
			id: "test.leaky",
			persistKey: "toolset-state:test.leaky",
			names: new Set(["leak-x"]),
			defaultEnabled: false,
		});
		defineToolset(pi, clean);
		defineToolset(pi, leaky);
		mock.setActiveTools(["clean-a", "leak-x"]);
		const drift = computeDrift(pi, branchOf(mock));
		expect(drift).toEqual([
			{ id: "test.leaky", fact: "test.leaky (intent off, 1 active)" },
		]);
	});

	it("in a deferring child, the spawner's deliberate tool set is not reported as drift", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "" });
		const spec = makeSpec({ names: new Set(["web-a"]), defaultEnabled: false });
		defineToolset(pi, spec);
		mock.setActiveTools(["web-a"]);
		process.env[DEFER_ENV] = String(process.pid + 12345);
		try {
			expect(computeDrift(pi, branchOf(mock))).toEqual([]);
		} finally {
			delete process.env[DEFER_ENV];
		}
	});

	// Intent resolves through the same tier chain as restore — these pin the
	// branch and settings tiers (the packaged-default tier is what every test
	// above already exercises).

	it("a branch entry overrides the packaged default", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "" });
		const spec = makeSpec({ names: new Set(["web-a"]), defaultEnabled: false });
		defineToolset(pi, spec);
		mock.appendEntry(spec.persistKey, { enabled: true });
		mock.setActiveTools(["web-a"]);
		// Packaged default says off (would flag a leak); the branch says on.
		expect(computeDrift(pi, branchOf(mock))).toEqual([]);
	});

	it("a settings pin is read: pinned-off with a member active is a leak", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "" });
		// No defaultEnabled: the packaged tier says on. Settings pin it off.
		const spec = makeSpec({ names: new Set(["web-a"]) });
		defineToolset(pi, spec);
		settings.writeJson(settings.globalSettings, {
			toolsetDefaults: { [spec.persistKey]: { enabled: false } },
		});
		mock.setActiveTools(["web-a"]);
		expect(computeDrift(pi, branchOf(mock))).toEqual([
			{ id: "test.web", fact: "test.web (intent off, 1 active)" },
		]);
	});

	it("under allowlist mode, membership is the intent", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "listed-a", description: "" });
		mock.registerTool({ name: "unlisted-a", description: "" });
		const listed = makeSpec({
			id: "test.listed",
			persistKey: "toolset-state:test.listed",
			names: new Set(["listed-a"]),
			defaultEnabled: false,
		});
		const unlisted = makeSpec({
			id: "test.unlisted",
			persistKey: "toolset-state:test.unlisted",
			names: new Set(["unlisted-a"]),
			defaultEnabled: false,
		});
		defineToolset(pi, listed);
		defineToolset(pi, unlisted);
		setDefaultResolutionMode(pi, "allowlist", ["test.listed"]);
		mock.setActiveTools(["listed-a", "unlisted-a"]);
		expect(computeDrift(pi, branchOf(mock))).toEqual([
			{ id: "test.unlisted", fact: "test.unlisted (intent off, 1 active)" },
		]);
	});

	it("an allowlisted member force-removed flags as intent on", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "listed-a", description: "" });
		const spec = makeSpec({
			id: "test.listed",
			persistKey: "toolset-state:test.listed",
			names: new Set(["listed-a"]),
			defaultEnabled: false,
		});
		defineToolset(pi, spec);
		setDefaultResolutionMode(pi, "allowlist", ["test.listed"]);
		mock.setActiveTools([]);
		expect(computeDrift(pi, branchOf(mock))).toEqual([
			{ id: "test.listed", fact: "test.listed (intent on, 0 of 1 active)" },
		]);
	});

	it("persists nothing and performs no writes", () => {
		const { mock, pi } = createEnv();
		mock.registerTool({ name: "web-a", description: "" });
		const spec = makeSpec({ names: new Set(["web-a"]), defaultEnabled: false });
		defineToolset(pi, spec);
		mock.setActiveTools(["web-a"]);
		const before = mock.getSetActiveCalls().length;
		const entriesBefore = mock.getEntries().length;
		computeDrift(pi, branchOf(mock));
		expect(mock.getEntries().length).toBe(entriesBefore);
		expect(mock.getSetActiveCalls().length).toBe(before);
	});
});
