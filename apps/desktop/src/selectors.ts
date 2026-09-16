export const EDITOR_INPUT_ATTR = "data-editor-input";
export const EDITOR_INPUT_SELECTOR = `[${EDITOR_INPUT_ATTR}]`;

export const SIDEBAR_NAV_ATTR = "data-sidebar-nav";
export const SIDEBAR_NAV_SELECTOR = `[${SIDEBAR_NAV_ATTR}]`;

/**
 * Anything that owns raw keystrokes. The last-resort Escape handler bails when
 * focus is inside one of these, so Escape keeps meaning "clear this field" /
 * "leave this editor" rather than "close the document".
 */
export const EDITABLE_FOCUS_SELECTOR =
	".ProseMirror, [contenteditable], input, textarea";

/**
 * The one Escape owner in this codebase that closes without calling
 * `preventDefault` (workspace-kit `comments/CommentThreadPopover.tsx`), so
 * `event.defaultPrevented` cannot speak for it. Gating on its own attribute
 * keeps the shared package — and therefore `apps/www` / `apps/notion-web`
 * Escape behaviour — byte-for-byte unchanged.
 */
export const COMMENT_THREAD_POPOVER_SELECTOR = "[data-comment-thread-popover]";
