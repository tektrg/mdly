import { describe, expect, it } from "vitest";
import {
	notionCommandPathEnv,
	notionMarkdownPatchBody,
	notionMarkdownUpdatePayload,
	resolveNotionCommandPath,
	shouldFallbackToFullNotionMarkdownUpdate,
} from "./notion";

describe("resolveNotionCommandPath", () => {
	it("finds ntn-acct in common macOS install locations when PATH omits it", () => {
		const executablePaths = new Set(["/usr/local/bin/ntn-acct"]);

		expect(
			resolveNotionCommandPath({
				pathEnv: "/usr/bin:/bin:/usr/sbin:/sbin",
				isExecutable: (filePath) => executablePaths.has(filePath),
			}),
		).toBe("/usr/local/bin/ntn-acct");
	});

	it("prefers PATH before common macOS install locations", () => {
		const executablePaths = new Set([
			"/custom/bin/ntn-acct",
			"/usr/local/bin/ntn-acct",
		]);

		expect(
			resolveNotionCommandPath({
				pathEnv: "/custom/bin:/usr/bin",
				isExecutable: (filePath) => executablePaths.has(filePath),
			}),
		).toBe("/custom/bin/ntn-acct");
	});

	it("allows an explicit command override", () => {
		expect(
			resolveNotionCommandPath({
				configuredCommand: "/custom/tools/ntn-acct",
				pathEnv: "",
				isExecutable: () => false,
			}),
		).toBe("/custom/tools/ntn-acct");
	});
});

describe("notionCommandPathEnv", () => {
	it("adds the resolved wrapper directory so ntn-acct can exec ntn", () => {
		expect(
			notionCommandPathEnv(
				"/usr/local/bin/ntn-acct",
				"/usr/bin:/bin:/usr/sbin:/sbin",
			).split(":"),
		).toEqual([
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		]);
	});
});

describe("notionMarkdownUpdatePayload", () => {
	const oldSignedUrl =
		"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/image.png?X-Amz-Signature=old";
	const currentSignedUrl =
		"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/image.png?X-Amz-Signature=current";

	it("builds a targeted update without treating rotated Notion file URLs as edits", () => {
		const payload = notionMarkdownUpdatePayload({
			previousMarkdown: `![diagram](${oldSignedUrl})\n\nOld copy`,
			currentMarkdown: `![diagram](${currentSignedUrl})\n\nOld copy`,
			nextMarkdown: `![diagram](${oldSignedUrl})\n\nNew copy`,
		});

		expect(payload).toEqual({
			kind: "targeted",
			oldStr: "Old",
			newStr: "New",
		});
		if (payload.kind !== "targeted") {
			throw new Error("Expected targeted payload");
		}
		expect(notionMarkdownPatchBody(payload)).toEqual({
			type: "update_content",
			update_content: {
				content_updates: [
					{
						old_str: "Old",
						new_str: "New",
					},
				],
			},
		});
	});

	it("expands repeated small diffs to a unique line-bounded targeted update", () => {
		expect(
			notionMarkdownUpdatePayload({
				previousMarkdown: `![diagram](${oldSignedUrl})\n\nA and A`,
				currentMarkdown: `![diagram](${currentSignedUrl})\n\nA and A`,
				nextMarkdown: `![diagram](${oldSignedUrl})\n\nB and A`,
			}),
		).toEqual({
			kind: "targeted",
			oldStr: "A and A",
			newStr: "B and A",
		});
	});

	it("noops when only a Notion signed image URL rotated", () => {
		expect(
			notionMarkdownUpdatePayload({
				previousMarkdown: `![diagram](${oldSignedUrl})`,
				currentMarkdown: `![diagram](${currentSignedUrl})`,
				nextMarkdown: `![diagram](${oldSignedUrl})`,
			}),
		).toEqual({
			kind: "noop",
			markdown: `![diagram](${currentSignedUrl})`,
		});
	});

	it("noops when only a Notion signed video URL rotated", () => {
		const oldVideoUrl =
			"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/video.mp4?X-Amz-Signature=old";
		const currentVideoUrl =
			"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/video.mp4?X-Amz-Signature=current";

		expect(
			notionMarkdownUpdatePayload({
				previousMarkdown: `<video src="${oldVideoUrl}"></video>`,
				currentMarkdown: `<video src="${currentVideoUrl}"></video>`,
				nextMarkdown: `<video src="${oldVideoUrl}"></video>`,
			}),
		).toEqual({
			kind: "noop",
			markdown: `<video src="${currentVideoUrl}"></video>`,
		});
	});

	it("preserves current Notion signed source URLs in targeted video updates", () => {
		const oldVideoUrl =
			"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/video.mp4?X-Amz-Signature=old";
		const currentVideoUrl =
			"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/video.mp4?X-Amz-Signature=current";

		expect(
			notionMarkdownUpdatePayload({
				previousMarkdown: `<video controls>\n<source src="${oldVideoUrl}" type="video/mp4">\n</video>\n\nOld copy`,
				currentMarkdown: `<video controls>\n<source src="${currentVideoUrl}" type="video/mp4">\n</video>\n\nOld copy`,
				nextMarkdown: `<video controls>\n<source src="${oldVideoUrl}" type="video/mp4">\n</video>\n\nNew copy`,
			}),
		).toEqual({
			kind: "targeted",
			oldStr: "Old",
			newStr: "New",
		});
	});

	it("uses whole current content as a targeted update when smaller ranges are ambiguous", () => {
		expect(
			notionMarkdownUpdatePayload({
				previousMarkdown: `![diagram](${oldSignedUrl})\n\nA\n\nA`,
				currentMarkdown: `![diagram](${currentSignedUrl})\n\nA\n\nA`,
				nextMarkdown: `![diagram](${oldSignedUrl})\n\nB\n\nA`,
			}),
		).toEqual({
			kind: "targeted",
			oldStr: `![diagram](${currentSignedUrl})\n\nA\n\nA`,
			newStr: `![diagram](${currentSignedUrl})\n\nB\n\nA`,
		});
	});
});

describe("shouldFallbackToFullNotionMarkdownUpdate", () => {
	const signedUrl =
		"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/image.png?X-Amz-Signature=current";

	it("falls back when Notion cannot match a targeted update on a text-only page", () => {
		expect(
			shouldFallbackToFullNotionMarkdownUpdate(
				new Error(
					"Public API request failed (400 Bad Request validation_error): No matches found for > Verdict",
				),
				{
					previousMarkdown: "Old copy",
					currentMarkdown: "Old copy",
					nextMarkdown: "New copy",
				},
			),
		).toBe(true);
	});

	it("keeps the targeted failure when a full update could clobber volatile file URLs", () => {
		expect(
			shouldFallbackToFullNotionMarkdownUpdate(
				new Error(
					"Public API request failed (400 Bad Request validation_error): No matches found for Old copy",
				),
				{
					previousMarkdown: `![diagram](${signedUrl})\n\nOld copy`,
					currentMarkdown: `![diagram](${signedUrl})\n\nOld copy`,
					nextMarkdown: `![diagram](${signedUrl})\n\nNew copy`,
				},
			),
		).toBe(false);
	});

	it("does not fall back for unrelated Notion failures", () => {
		expect(
			shouldFallbackToFullNotionMarkdownUpdate(new Error("Unauthorized"), {
				previousMarkdown: "Old copy",
				currentMarkdown: "Old copy",
				nextMarkdown: "New copy",
			}),
		).toBe(false);
	});
});
