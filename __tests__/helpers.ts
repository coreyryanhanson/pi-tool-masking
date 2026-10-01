// Shared test-rig state sweep. One canonical list of every process-global
// key pi-tool-masking stashes on globalThis, plus the defer env var, so no
// test file has to remember which keys exist.

export const REGISTRY_KEY = "__piToolMaskingRegistry";

const GLOBAL_KEYS = [
	"__piToolMaskingRegistry",
	"__piToolMaskingLastRestoreEvent",
	"__piToolMaskingModuleState",
	"__piToolMaskingChildPolicyWarned",
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
