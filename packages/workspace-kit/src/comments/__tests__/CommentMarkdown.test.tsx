// @vitest-environment happy-dom

import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommentMarkdown } from "../CommentMarkdown";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("CommentMarkdown", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(text: string) {
		act(() => {
			root.render(<CommentMarkdown text={text} />);
		});
	}

	it("renders **bold** as <strong>, not literal asterisks", () => {
		render("why **bold**?");
		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(container.textContent).not.toContain("**");
	});

	it("renders _italic_ as <em>, not literal underscores", () => {
		render("why _italic_?");
		expect(container.querySelector("em")?.textContent).toBe("italic");
		expect(container.textContent).not.toContain("_italic_");
	});

	it("renders `inline code` as <code>, not literal backticks", () => {
		render("run `pnpm test` now");
		expect(container.querySelector("code")?.textContent).toBe("pnpm test");
		expect(container.textContent).not.toContain("`");
	});

	it("renders a link as an <a> that opens in a new tab safely", () => {
		render("see [the docs](https://example.com/docs)");
		const link = container.querySelector("a");
		expect(link?.getAttribute("href")).toBe("https://example.com/docs");
		expect(link?.textContent).toBe("the docs");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noreferrer");
	});

	it("renders an unordered list as <ul><li>", () => {
		render("- one\n- two");
		const items = container.querySelectorAll("ul > li");
		expect(items).toHaveLength(2);
		expect(items[0]?.textContent).toBe("one");
		expect(items[1]?.textContent).toBe("two");
	});

	it("renders an ordered list as <ol><li>", () => {
		render("1. first\n2. second");
		expect(container.querySelector("ol")).not.toBeNull();
		const items = container.querySelectorAll("ol > li");
		expect(items).toHaveLength(2);
		expect(items[0]?.textContent).toBe("first");
	});

	it("renders GFM ~~strikethrough~~ as <del>, not literal tildes", () => {
		render("this was ~~removed~~");
		expect(container.querySelector("del")?.textContent).toBe("removed");
		expect(container.textContent).not.toContain("~~");
	});

	it("never uses dangerouslySetInnerHTML -- raw HTML in the source text is not parsed as markup", () => {
		render("<img src=x onerror=alert(1)>");
		expect(container.querySelector("img")).toBeNull();
	});

	it("renders a javascript: link as plain, non-clickable text instead of an <a>", () => {
		render("[click me](javascript:alert(1))");
		expect(container.querySelector("a")).toBeNull();
		expect(container.textContent).toBe("click me");
	});

	it("renders a data: link as plain text", () => {
		render("[open](data:text/html,alert(1))");
		expect(container.querySelector("a")).toBeNull();
		expect(container.textContent).toBe("open");
	});

	it("renders a vbscript: link as plain text", () => {
		render("[run](vbscript:msgbox(1))");
		expect(container.querySelector("a")).toBeNull();
		expect(container.textContent).toBe("run");
	});

	it("still renders a mailto: link as a clickable <a>", () => {
		render("[email me](mailto:a@b.com)");
		const link = container.querySelector("a");
		expect(link?.getAttribute("href")).toBe("mailto:a@b.com");
		expect(link?.textContent).toBe("email me");
	});

	it("still renders a scheme-less relative link as a clickable <a>", () => {
		render("[section](#section-2)");
		const link = container.querySelector("a");
		expect(link?.getAttribute("href")).toBe("#section-2");
		expect(link?.textContent).toBe("section");
	});
});
