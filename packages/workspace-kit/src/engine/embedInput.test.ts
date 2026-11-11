import { describe, expect, it } from "vitest";
import { extractIframeEmbedMarkdown, parseEmbedInput } from "./embedInput";

describe("parseEmbedInput (/embed prompt)", () => {
	it("keeps pasted https iframe code byte-identical", () => {
		const raw =
			'<iframe src="https://www.youtube.com/embed/abc" title="v" allowfullscreen></iframe>';
		expect(parseEmbedInput(raw)).toEqual({
			ok: true,
			attrs: {
				kind: "iframe",
				src: "https://www.youtube.com/embed/abc",
				raw,
				width: null,
				height: null,
			},
		});
	});

	it("wraps a bare https URL in a default-sized iframe", () => {
		const result = parseEmbedInput("  https://example.com/a?b=1&c=2 ");
		expect(result).toEqual({
			ok: true,
			attrs: {
				kind: "iframe",
				src: "https://example.com/a?b=1&c=2",
				raw: '<iframe src="https://example.com/a?b=1&amp;c=2" width="100%" height="480"></iframe>',
				width: "100%",
				height: "480",
			},
		});
	});

	it("accepts a local .html iframe", () => {
		const result = parseEmbedInput('<iframe src="charts/a.html"></iframe>');
		expect(result.ok).toBe(true);
	});

	it.each([
		"",
		"http://example.com",
		'<iframe src="http://example.com"></iframe>',
		'<iframe src="javascript:alert(1)"></iframe>',
		'<iframe src="data:text/html,hi"></iframe>',
		'<iframe src="file:///etc/x.html"></iframe>',
		"not a url",
		'<iframe src="https://a.com"></iframe> trailing text',
	])("rejects %j with an error message", (input) => {
		const result = parseEmbedInput(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});
});

describe("extractIframeEmbedMarkdown (clipboard HTML)", () => {
	it("pulls valid iframes out of clipboard HTML that holds only iframes", () => {
		const html =
			'<meta charset="utf-8"><iframe src="https://a.com/x" width="560"></iframe>';
		expect(extractIframeEmbedMarkdown(html)).toBe(
			'<iframe src="https://a.com/x" width="560"></iframe>',
		);
	});

	it("ignores HTML with other visible text", () => {
		expect(
			extractIframeEmbedMarkdown(
				'<p>Hello</p><iframe src="https://a.com/x"></iframe>',
			),
		).toBeNull();
	});

	it("ignores invalid sources", () => {
		expect(
			extractIframeEmbedMarkdown('<iframe src="http://a.com/x"></iframe>'),
		).toBeNull();
	});
});
