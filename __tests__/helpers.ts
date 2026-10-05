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
