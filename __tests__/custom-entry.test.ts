import { describe, it, expect } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { lastCustomEntry } from "../index.js";

const TS = "2026-01-01T00:00:00.000Z";

function customEntry(
	customType: string,
	data: unknown,
	id: string,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: TS,
		customType,
		data,
	} as SessionEntry;
}

describe("lastCustomEntry", () => {
	it("returns the newest matching custom entry", () => {
		const branch: SessionEntry[] = [
			customEntry("m", { v: 1 }, "a"),
			customEntry("m", { v: 2 }, "b"),
			customEntry("other", { v: 0 }, "c"),
		];
		const result = lastCustomEntry<{ v: number }>(branch, "m");
		expect(result?.customType).toBe("m");
		expect(result?.data).toEqual({ v: 2 });
	});

	it("returns a tombstone entry (data null) instead of skipping it", () => {
		const branch: SessionEntry[] = [
			customEntry("m", { v: 1 }, "a"),
			customEntry("m", null, "b"),
		];
		const result = lastCustomEntry<{ v: number } | null>(branch, "m");
		expect(result).toBeDefined();
		expect(result?.data).toBeNull();
	});

	it("skips non-custom members and other customTypes", () => {
		const branch: SessionEntry[] = [
			{
				type: "model_change",
				id: "a",
				parentId: null,
				timestamp: TS,
				provider: "p",
				modelId: "m",
			},
			customEntry("m", { v: 1 }, "b"),
			{
				type: "custom",
				id: "c",
				parentId: null,
				timestamp: TS,
				customType: "nope",
				data: { v: 9 },
			},
		];
		const result = lastCustomEntry<{ v: number }>(branch, "m");
		expect(result?.customType).toBe("m");
		expect(result?.data).toEqual({ v: 1 });
	});

	it("returns undefined when no customType matches", () => {
		const branch: SessionEntry[] = [customEntry("x", { v: 1 }, "a")];
		expect(lastCustomEntry(branch, "m")).toBeUndefined();
	});
});
