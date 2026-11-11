import { describe, expect, it } from "vitest";
import {
	indexMovedFiles,
	pathAfterMove,
	rewriteMovedLinks,
} from "./markdownLinkRewrite";

describe("pathAfterMove", () => {
	it("matches descendants when moved paths use Windows separators", () => {
		const movedByOldPath = indexMovedFiles([
			{
				fromPath: "C:\\workspace\\note.assets",
				toPath: "C:\\workspace\\renamed.assets",
			},
		]);

		expect(
			pathAfterMove("C:/workspace/note.assets/image.png", movedByOldPath),
		).toBe("C:/workspace/renamed.assets/image.png");
	});
});

describe("rewriteMovedLinks with sized images", () => {
	it("rewrites an Obsidian |400 image and keeps the size suffix", () => {
		const movedByOldPath = indexMovedFiles([
			{ fromPath: "/ws/note.assets", toPath: "/ws/renamed.assets" },
		]);
		const content =
			"::: columns\n![Before|400](note.assets/a.png)\n+++\n![After|300x200](note.assets/b.png)\n:::";
		expect(
			rewriteMovedLinks({
				content,
				filePath: "/ws/note.md",
				nextPath: "/ws/note.md",
				workspacePath: "/ws",
				movedByOldPath,
			}),
		).toBe(
			"::: columns\n![Before|400](renamed.assets/a.png)\n+++\n![After|300x200](renamed.assets/b.png)\n:::",
		);
	});
});
