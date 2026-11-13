/** Cmd+Enter (Ctrl+Enter off macOS) submits a comment textarea. Plain Enter stays a newline. */
export function isSubmitShortcut(event: {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	isComposing?: boolean;
}): boolean {
	return (
		event.key === "Enter" &&
		!event.isComposing &&
		!event.shiftKey &&
		!event.altKey &&
		Boolean(event.metaKey || event.ctrlKey)
	);
}

export const SUBMIT_SHORTCUT_HINT = "⌘↩";
export const SUBMIT_SHORTCUT_ARIA = "Meta+Enter";
