/**
 * Markdown-only gate (R7). Only Markdown files are ever versioned — never
 * binary assets, never `.html` HTML Apps. Mirrors the extension set the
 * desktop app itself treats as Markdown (`apps/desktop/src/lib/filePath.ts`'s
 * `hasMarkdownExtension`), kept here as an independent, dependency-free
 * check so this package never needs to import an app-specific module.
 */
const MARKDOWN_EXTENSION_RE = /\.(md|markdown|mdown)$/i;

export function isVersionableMarkdownPath(path: string): boolean {
	return MARKDOWN_EXTENSION_RE.test(path);
}
