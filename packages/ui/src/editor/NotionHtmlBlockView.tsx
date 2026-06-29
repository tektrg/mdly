import { NotionHtmlBlockExtension } from "@hubble.md/editor";
import {
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import MingcuteArrowRightLine from "~icons/mingcute/arrow-right-line";

type NotionHtmlBlockViewOptions = {
	onOpenExternalLink: (href: string) => void | Promise<void>;
};

export function createNotionHtmlBlockViewExtension({
	onOpenExternalLink,
}: NotionHtmlBlockViewOptions) {
	return NotionHtmlBlockExtension.extend({
		addNodeView() {
			return ReactNodeViewRenderer((props) => (
				<NotionHtmlBlockView
					{...props}
					onOpenExternalLink={onOpenExternalLink}
				/>
			));
		},
	});
}

function NotionHtmlBlockView({
	node,
	onOpenExternalLink,
}: NodeViewProps & NotionHtmlBlockViewOptions) {
	const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
	const videoUrl = videoSourceUrl(raw);
	const href = videoUrl ?? linkLikeUrl(raw);
	const label = href ? hostLabel(href) : "Unavailable";

	return (
		<NodeViewWrapper className="pm-notion-html-block" as="div">
			<div className="pm-notion-html-block-card">
				<div className="pm-notion-html-block-label">
					<span className="pm-notion-html-block-kicker">
						{videoUrl ? "Video" : "Notion block"}
					</span>
					<span className="pm-notion-html-block-url">{label}</span>
				</div>
				{href ? (
					<button
						aria-label="Open media link"
						className="pm-notion-html-block-open"
						type="button"
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => void onOpenExternalLink(href)}
					>
						<MingcuteArrowRightLine aria-hidden="true" />
					</button>
				) : null}
			</div>
		</NodeViewWrapper>
	);
}

function videoSourceUrl(raw: string): string | null {
	const videoTag = raw.match(/<video\b[^>]*>/i)?.[0] ?? "";
	const directSrc = htmlAttributeValue(videoTag, "src");
	if (directSrc) return directSrc;
	const sourceTag = raw.match(/<source\b[^>]*>/i)?.[0] ?? "";
	return htmlAttributeValue(sourceTag, "src");
}

function linkLikeUrl(raw: string): string | null {
	const firstTag = raw.match(/<[a-z][\w:-]*\b[^>]*>/i)?.[0] ?? "";
	return (
		htmlAttributeValue(firstTag, "url") ?? htmlAttributeValue(firstTag, "href")
	);
}

function htmlAttributeValue(tag: string, name: string): string | null {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = tag.match(
		new RegExp(
			`\\s${escapedName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
			"i",
		),
	);
	return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function hostLabel(href: string): string {
	try {
		return new URL(href).hostname || href;
	} catch {
		return href;
	}
}
