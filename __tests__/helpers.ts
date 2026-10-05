import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BranchReader } from "../index.js";
import { MockPI } from "./mock-pi.js";

// Shared test-rig state sweep. One canonical list of every process-global
// key pi-tool-masking stashes on globalThis, plus the defer env var, so no
// test file has to remember which keys exist.

export const REGISTRY_KEY = "__piToolMaskingRegistry";

export function createEnv(): { mock: MockPI; pi: ExtensionAPI } {
	const mock = new MockPI();
	return { mock, pi: mock as unknown as ExtensionAPI };
}

export function reader(pi: ExtensionAPI): BranchReader {
	return (pi as unknown as MockPI).branchReader();
}

const GLOBAL_KEYS = [
	"__piToolMaskingRegistry",
	"__piToolMaskingLastRestoreEvent",
	"__piToolMaskingChildPolicyWarned",
	"__piToolMaskingHandlerInstalled",
] as const;

/** Delete all globalThis module keys (defer env var untouched). */
export function cleanGlobalKeys(): void {
	for (const key of GLOBAL_KEYS) {
		delete (globalThis as any)[key];
	}
}

/** Full sweep: globalThis keys + the PI_TOOLMASKING_DEFER env var. */
export function cleanRegistry(): void {
	cleanGlobalKeys();
	// Deferring-child residue: a foreign-pid var left by a defer test would
	// make a later restore silently defer and skip masking.
	delete process.env["PI_TOOLMASKING_DEFER"];
}

/** Catch by `err?.name` — the copy-safe contract for AllowlistModeError
 *  (never `instanceof`, which breaks across physical library copies).
 *  Returns the caught error, or throws when `fn` did not throw. */
export function catchByName(
	fn: () => unknown,
): { name?: string; specId?: string } {
	try {
		fn();
	} catch (e) {
		return e as { name?: string; specId?: string };
	}
	throw new Error("expected fn to throw");
}

// ---------------------------------------------------------------------------
// Temp settings dir — real settings.json files, never the developer's ~/.pi
// ---------------------------------------------------------------------------

let current: {
	tmp: string;
	origCwd: string;
	origAgentDir: string | undefined;
} | null = null;

/**
 * Call once at file scope (module level): isolates `PI_CODING_AGENT_DIR` and the
 * process cwd into a fresh mkdtemp dir per test, so global settings live at
 * `<tmp>/agent/settings.json` and project settings at `<tmp>/.pi/settings.json`.
 * Returns paths and a raw-JSON writer for seeding files; missing files read as
 * empty settings, so an unseeded test needs no setup.
 */
export function useTempSettingsDir(): {
	globalSettings: string;
	projectSettings: string;
	writeJson(path: string, data: unknown): void;
} {
	beforeEach(() => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-tool-masking-settings-"));
		mkdirSync(join(tmp, "agent"), { recursive: true });
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		current = {
			tmp,
			origCwd: process.cwd(),
			origAgentDir: process.env.PI_CODING_AGENT_DIR,
		};
		process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
		process.chdir(tmp);
	});
	afterEach(() => {
		if (current === null) return;
		process.chdir(current.origCwd);
		if (current.origAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = current.origAgentDir;
		}
		rmSync(current.tmp, { recursive: true, force: true });
		current = null;
	});
	return {
		get globalSettings() {
			if (current === null) throw new Error("useTempSettingsDir not active");
			return join(current.tmp, "agent", "settings.json");
		},
		get projectSettings() {
			if (current === null) throw new Error("useTempSettingsDir not active");
			return join(current.tmp, ".pi", "settings.json");
		},
		writeJson(path, data) {
			writeFileSync(path, JSON.stringify(data, null, 2));
		},
	};
}
