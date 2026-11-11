// Shared rules for `<iframe>` embeds in Markdown: which srcs become embed
// nodes, and how the original HTML is kept byte-identical on save.

const BLOCKED_IFRAME_SCHEME = /^(file:|data:|javascript:|hubble-asset:)/i;
const LOCAL_IFRAME_SRC = /^(\.{1,2}\/|[^:/\\]+(?:\/|$)).*\.html(?:[?#].*)?$/i;

/** True for an absolute `https:` URL with a host (the only remote form allowed). */
export function isRemoteIframeSrc(src: string): boolean {
	if (!/^https:\/\//i.test(src.trim())) return false;
	try {
		const url = new URL(src.trim());
		return url.protocol === "https:" && url.hostname.length > 0;
	} catch {
		return false;
	}
}

/**
 * Iframe embeds may point to a workspace-local `.html` file (resolved relative
 * to the Markdown file) or to any `https:` URL. `http:`, `javascript:`,
 * `data:`, `file:`, app-internal schemes, protocol-relative and local absolute
 * paths are rejected and stay as raw text.
 */
export function isValidIframeEmbedSrc(src: string): boolean {
	if (!src.trim()) return false;
	if (BLOCKED_IFRAME_SCHEME.test(src)) return false;
	if (isRemoteIframeSrc(src)) return true;
	if (src.startsWith("/") || src.startsWith("\\") || src.startsWith("//")) {
		return false;
	}
	return LOCAL_IFRAME_SRC.test(src);
}

type TagAttr = {
	name: string;
	/** Offsets of the whole ` name="value"` token inside the raw string. */
	start: number;
	end: number;
	value: string | null;
	quote: '"' | "'" | "";
};

const ATTR_TOKEN =
	/\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

/** Scans the attributes of the leading `<iframe …>` opening tag. */
function scanOpeningTag(raw: string): { attrs: TagAttr[]; end: number } | null {
	const open = /^\s*<iframe\b/i.exec(raw);
	if (!open) return null;
	const attrs: TagAttr[] = [];
	let index = open[0].length;
	while (index < raw.length) {
		ATTR_TOKEN.lastIndex = index;
		const match = ATTR_TOKEN.exec(raw);
		if (!match) break;
		const [, name, dq, sq, bare] = match;
		attrs.push({
			name: (name ?? "").toLowerCase(),
			start: index,
			end: ATTR_TOKEN.lastIndex,
			value: dq ?? sq ?? bare ?? null,
			quote: dq !== undefined ? '"' : sq !== undefined ? "'" : "",
		});
		index = ATTR_TOKEN.lastIndex;
	}
	const close = /^\s*\/?>/.exec(raw.slice(index));
	if (!close) return null;
	return { attrs, end: index };
}

/** Reads one attribute of the raw `<iframe>` tag (null when absent). */
export function readIframeAttr(raw: string, name: string): string | null {
	const scanned = scanOpeningTag(raw);
	const attr = scanned?.attrs.find((a) => a.name === name.toLowerCase());
	return attr ? (attr.value ?? "") : null;
}

/**
 * Sets one attribute on the raw `<iframe>` tag in place, keeping every other
 * byte (attribute order, quoting, spacing) as written. A missing attribute is
 * appended at the end of the opening tag.
 */
export function setIframeAttr(
	raw: string,
	name: string,
	value: string,
): string {
	const scanned = scanOpeningTag(raw);
	if (!scanned) return raw;
	const escaped = value.split("&").join("&amp;").split('"').join("&quot;");
	const attr = scanned.attrs.find((a) => a.name === name.toLowerCase());
	if (!attr) {
		return `${raw.slice(0, scanned.end)} ${name}="${escaped}"${raw.slice(scanned.end)}`;
	}
	const token = raw.slice(attr.start, attr.end);
	const leading = /^\s+/.exec(token)?.[0] ?? " ";
	const nameText = token.slice(leading.length, leading.length + name.length);
	const quote = attr.quote === "'" && !value.includes("'") ? "'" : '"';
	const quoted = quote === "'" ? `'${value}'` : `"${escaped}"`;
	return `${raw.slice(0, attr.start)}${leading}${nameText}=${quoted}${raw.slice(attr.end)}`;
}

/**
 * Markdown for an embed node: the original HTML when we have it (with only
 * `width`/`height` rewritten if the user resized), otherwise a minimal tag.
 */
export function iframeEmbedToMarkdown(attrs: Record<string, unknown>): string {
	const src = String(attrs.src ?? "");
	if (!isValidIframeEmbedSrc(src)) return "";
	const width = optionalString(attrs.width);
	const height = optionalString(attrs.height);
	const raw = typeof attrs.raw === "string" ? attrs.raw : "";
	const rawSrc = raw ? readIframeAttr(raw, "src") : null;
	if (rawSrc !== null && decodeAttrEntities(rawSrc) === src) {
		let out = raw;
		if (width !== null && readIframeAttr(out, "width") !== width) {
			out = setIframeAttr(out, "width", width);
		}
		if (height !== null && readIframeAttr(out, "height") !== height) {
			out = setIframeAttr(out, "height", height);
		}
		return out;
	}
	const sizes = [
		width !== null ? ` width="${escapeAttr(width)}"` : "",
		height !== null ? ` height="${escapeAttr(height)}"` : "",
	].join("");
	return `<iframe src="${escapeAttr(src)}"${sizes}></iframe>`;
}

/** Decodes the character references an HTML parser would in an attribute. */
function decodeAttrEntities(value: string): string {
	const named: Record<string, string> = {
		amp: "&",
		quot: '"',
		apos: "'",
		lt: "<",
		gt: ">",
	};
	return value.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(entity, body: string) => {
			if (body[0] === "#") {
				const code =
					body[1] === "x" || body[1] === "X"
						? Number.parseInt(body.slice(2), 16)
						: Number.parseInt(body.slice(1), 10);
				return Number.isFinite(code) && code <= 0x10ffff
					? String.fromCodePoint(code)
					: entity;
			}
			return named[body.toLowerCase()] ?? entity;
		},
	);
}

function optionalString(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string" && value.length > 0) return value;
	return null;
}

function escapeAttr(value: string) {
	return value
		.split("&")
		.join("&amp;")
		.split('"')
		.join("&quot;")
		.split("<")
		.join("&lt;")
		.split(">")
		.join("&gt;");
}
