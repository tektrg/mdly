import { describe, expect, it } from "vitest";
import { authedJson, fetchWithBearer, jsonBody } from "./testHelpers.js";

/**
 * QA12a (R8): two Macs racing a write to the same path never corrupt the
 * stored row and never error — the DO serializes the writes (no `await`
 * between the SQL read and write in `upsertFile`, see
 * worker/durableObject/files.ts), so the accepted outcome is deterministic
 * last-write-wins, not a race that could interleave two writers' bytes.
 */
describe("concurrent pushes to the same path never corrupt data (R8)", () => {
	it("two simultaneous pushFile calls both succeed and the stored row is one whole write, never a mix", async () => {
		const workspaceId = "concurrent-write-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const contentA = "A".repeat(5000);
		const contentB = "B".repeat(5000);

		const [resultA, resultB] = await Promise.all([
			authedJson<{ ok: true; version: number }>("/api/files", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "race.md",
					contentHash: "hash-a",
					content: contentA,
					deviceId: "mac-a",
				}),
			}),
			authedJson<{ ok: true; version: number }>("/api/files", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "race.md",
					contentHash: "hash-b",
					content: contentB,
					deviceId: "mac-b",
				}),
			}),
		]);

		expect(resultA.body.ok).toBe(true);
		expect(resultB.body.ok).toBe(true);

		const files = await authedJson<{
			files: {
				path: string;
				content: string;
				contentHash: string;
				deviceId: string;
			}[];
		}>(`/api/files?workspaceId=${workspaceId}`);
		expect(files.body.files).toHaveLength(1);

		const stored = files.body.files[0];
		if (!stored) throw new Error("expected a stored row");
		const isWhollyA =
			stored.content === contentA &&
			stored.contentHash === "hash-a" &&
			stored.deviceId === "mac-a";
		const isWhollyB =
			stored.content === contentB &&
			stored.contentHash === "hash-b" &&
			stored.deviceId === "mac-b";
		expect(isWhollyA || isWhollyB).toBe(true);
	});

	it("many concurrent pushes to the same path settle on exactly one whole write", async () => {
		const workspaceId = "concurrent-write-ws-many";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const writers = Array.from({ length: 8 }, (_, i) => i);
		await Promise.all(
			writers.map((i) =>
				authedJson("/api/files", {
					method: "POST",
					...jsonBody({
						workspaceId,
						path: "race-many.md",
						contentHash: `hash-${i}`,
						content: `writer-${i}`.repeat(100),
						deviceId: `mac-${i}`,
					}),
				}),
			),
		);

		const files = await authedJson<{
			files: { content: string; contentHash: string }[];
		}>(`/api/files?workspaceId=${workspaceId}`);
		expect(files.body.files).toHaveLength(1);
		const stored = files.body.files[0];
		if (!stored) throw new Error("expected a stored row");
		const writerIndex = Number(/hash-(\d+)/.exec(stored.contentHash)?.[1]);
		expect(stored.content).toBe(`writer-${writerIndex}`.repeat(100));
	});
});
