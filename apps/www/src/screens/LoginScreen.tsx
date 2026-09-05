import { loginWithPassword } from "@mdly/cloudflare-client";
import { useState } from "react";
import { WORKER_BASE_URL } from "../connection/workerUrl";

type Props = {
	onLoggedIn: () => void;
};

/** Replaces the old Convex-era ConnectScreen (D6/D8) — there's one Worker, same-origin, gated by a single shared password (POST /api/login sets the session cookie). */
export function LoginScreen({ onLoggedIn }: Props) {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!password) return;
		setBusy(true);
		setError(null);
		try {
			const ok = await loginWithPassword(WORKER_BASE_URL, password);
			if (!ok) {
				setError("Incorrect password.");
				return;
			}
			onLoggedIn();
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Couldn't reach the server. Check your connection.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<main className="flex h-dvh items-center justify-center bg-background text-foreground">
			<form
				onSubmit={handleSubmit}
				className="flex w-full max-w-md flex-col gap-3 rounded-md border border-border bg-sidebar p-6"
			>
				<div>
					<h1 className="m-0 text-base font-semibold">mdly</h1>
					<p className="m-0 mt-1 text-xs text-muted-foreground">
						Enter the Cloud Sync password to continue.
					</p>
				</div>
				<input
					type="password"
					// biome-ignore lint/a11y/noAutofocus: deliberate — single-field login screen
					autoFocus
					required
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					placeholder="Password"
					disabled={busy}
					className="rounded-sm border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
				/>
				{error && (
					<p className="m-0 rounded-sm bg-muted px-2.5 py-1.5 text-xs text-destructive">
						{error}
					</p>
				)}
				<button
					type="submit"
					disabled={busy}
					className="rounded-sm bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
				>
					{busy ? "Logging in…" : "Log in"}
				</button>
			</form>
		</main>
	);
}
