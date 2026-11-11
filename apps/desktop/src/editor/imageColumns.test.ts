import { columnsExtensions, markdownToTiptapDoc } from "@mdly/workspace-kit";
import { getSchema } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Node } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vitest";

vi.mock("../desktopApi", () => ({ desktopApi: {} }));

const { groupImagesForColumns } = await import("./handleImagePaste");
const { columnGroupImages } = await import("./ImageNodeView");

describe("groupImagesForColumns", () => {
	it("keeps one image single", () => {
		expect(groupImagesForColumns(["a"], false)).toEqual([["a"]]);
	});
	it("groups several images, capped at 4 per group", () => {
		expect(groupImagesForColumns([1, 2, 3, 4, 5], false)).toEqual([
			[1, 2, 3, 4],
			[5],
		]);
	});
	it("never nests: inside a column every image stays single", () => {
		expect(groupImagesForColumns([1, 2], true)).toEqual([[1], [2]]);
	});
});

describe("columnGroupImages", () => {
	const schema = getSchema([
		StarterKit,
		Image.configure({ inline: false }),
		...columnsExtensions,
	]);
	const doc = Node.fromJSON(
		schema,
		markdownToTiptapDoc(
			"![solo](s.png)\n\n::: columns\n![A](a.png)\n+++\ntext\n\n![B](b.png)\n:::",
		),
	);
	const positions: number[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name === "image") positions.push(pos);
	});

	it("returns null outside a columns group", () => {
		expect(columnGroupImages(doc, positions[0] ?? -1)).toBeNull();
	});
	it("lists sibling images and the clicked index", () => {
		expect(columnGroupImages(doc, positions[2] ?? -1)).toEqual({
			images: [
				{ src: "a.png", alt: "A" },
				{ src: "b.png", alt: "B" },
			],
			index: 1,
		});
	});
});
