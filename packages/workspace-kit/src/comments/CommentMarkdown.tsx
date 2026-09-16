import type { Root, RootContent } from "mdast";
import type { ReactNode } from "react";
import { Fragment } from "react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Parsing only (no `.process()`/stringify): remark-gfm's attacher registers
// its micromark syntax extensions with the processor synchronously when
// `.use()` runs, so a bare `.parse()` below already understands GFM
// strikethrough/autolinks -- no `.run()` pass is needed to get an
// already-GFM-aware mdast tree.
const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * True for a link href safe to render as a live, clickable `<a>`: an
 * absolute `http:`/`https:`/`mailto:` URL, or a scheme-less reference
 * (`#section`, `/path`, `./doc.md`) that resolves relative to the current
 * page. Comment text is untrusted author-supplied content, so anything else
 * -- most importantly `javascript:`/`data:`/`vbscript:` -- must never reach
 * a real `href`, or clicking a rendered comment link could execute
 * arbitrary script. `URL`'s own WHATWG parsing also strips the
 * tab/newline scheme-obfuscation tricks browsers ignore (e.g.
 * `"java\nscript:alert(1)"` still parses to protocol `javascript:`), so this
 * can't be bypassed by hiding the scheme inside the string.
 */
function isSafeLinkHref(href: string): boolean {
	try {
		const url = new URL(href, "https://comment-link-base.invalid/");
		return SAFE_LINK_SCHEMES.has(url.protocol);
	} catch {
		return false;
	}
}

/**
 * Walks one mdast node into a plain React element -- never
 * `dangerouslySetInnerHTML`, so there is no HTML-injection surface for
 * comment text a different author/agent wrote. Deliberately covers only the
 * subset a short comment realistically uses (paragraphs, bold/italic/
 * strikethrough, inline code, links, lists); anything else falls through to
 * rendering its children (or nothing, for a childless/unknown leaf) rather
 * than crashing on a comment containing markdown this renderer doesn't know
 * about yet.
 */
function renderNode(node: RootContent, key: number): ReactNode {
	switch (node.type) {
		case "paragraph":
			return <p key={key}>{renderChildren(node.children)}</p>;
		case "strong":
			return <strong key={key}>{renderChildren(node.children)}</strong>;
		case "emphasis":
			return <em key={key}>{renderChildren(node.children)}</em>;
		case "delete":
			return <del key={key}>{renderChildren(node.children)}</del>;
		case "inlineCode":
			return <code key={key}>{node.value}</code>;
		case "link": {
			const children = renderChildren(node.children);
			if (!isSafeLinkHref(node.url)) {
				// Unsafe scheme -- render the link text as plain text instead
				// of a clickable element rather than dropping it silently.
				return <Fragment key={key}>{children}</Fragment>;
			}
			return (
				<a key={key} href={node.url} target="_blank" rel="noreferrer">
					{children}
				</a>
			);
		}
		case "list":
			return node.ordered ? (
				<ol key={key} start={node.start ?? undefined}>
					{renderChildren(node.children)}
				</ol>
			) : (
				<ul key={key}>{renderChildren(node.children)}</ul>
			);
		case "listItem":
			return <li key={key}>{renderChildren(node.children)}</li>;
		case "break":
			return <br key={key} />;
		case "text":
			return node.value;
		default:
			return "children" in node ? (
				<Fragment key={key}>{renderChildren(node.children)}</Fragment>
			) : null;
	}
}

function renderChildren(children: RootContent[]): ReactNode[] {
	return children.map((child, index) => renderNode(child, index));
}

/** Read-only Markdown -> React renderer for a comment body (opener text, reply text, log-line text). */
export function CommentMarkdown({ text }: { text: string }) {
	const tree = markdownProcessor.parse(text) as Root;
	return <>{renderChildren(tree.children)}</>;
}
