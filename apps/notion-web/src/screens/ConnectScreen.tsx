import type { SessionStatus } from "../notion/types";

const ERROR_MESSAGES: Record<string, string> = {
	not_configured:
		"This deployment isn't configured with Notion credentials yet. Set NOTION_CLIENT_ID and NOTION_CLIENT_SECRET on the Worker.",
	invalid_state:
		"The sign-in request expired or didn't match. Please try connecting again.",
	access_denied: "Notion access was declined. Connect again to continue.",
};

function errorFromUrl(): string | null {
	const params = new URLSearchParams(window.location.search);
	const error = params.get("error");
	if (!error) return null;
	return ERROR_MESSAGES[error] ?? `Notion sign-in failed: ${error}`;
}

export function ConnectScreen({ session }: { session: SessionStatus }) {
	const error = errorFromUrl();

	return (
		<div className="flex h-full items-center justify-center p-6">
			<div className="w-full max-w-md text-center">
				<div className="mb-6 flex justify-center">
					<div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--foreground)] font-mono text-2xl font-bold text-[var(--background)]">
						m
					</div>
				</div>
				<h1 className="mb-2 text-2xl font-semibold">mdly</h1>
				<p className="mb-8 text-sm opacity-70">
					A lightweight editor for your Notion pages. Connect your workspace to
					browse pages, edit them as clean markdown, and push changes back.
				</p>

				{error ? (
					<p className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-left text-sm text-red-500">
						{error}
					</p>
				) : null}

				{session.configured ? (
					<a
						href="/auth/notion/start"
						className="inline-flex items-center justify-center rounded-lg bg-[var(--foreground)] px-5 py-2.5 text-sm font-medium text-[var(--background)] transition-opacity hover:opacity-90"
					>
						Connect Notion
					</a>
				) : (
					<p className="rounded-lg border border-[var(--border)] px-4 py-3 text-left text-sm opacity-70">
						Notion credentials are not configured on this deployment yet.
					</p>
				)}
			</div>
		</div>
	);
}
