import { api } from "@hubble.md/sync-backend";
import { Button } from "@hubble.md/ui";
import { Input } from "@mdly/workspace-kit";
import type { ConvexHttpClient } from "convex/browser";
import { useState } from "react";
import { categorizeError, describeError } from "../connection/convex-error";

type Props = {
	client: ConvexHttpClient;
	onCreated: (id: string) => void;
};

export function CreateWorkspaceForm({ client, onCreated }: Props) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleCreate = async (event: React.FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		setBusy(true);
		setError(null);
		try {
			const id = await client.mutation(api.sync.createWorkspace, {
				name: trimmed,
			});
			onCreated(id);
		} catch (err) {
			setError(describeError(categorizeError(err)));
			setBusy(false);
		}
	};

	return (
		<form onSubmit={handleCreate} className="flex flex-col gap-2">
			<Input
				type="text"
				autoFocus
				required
				value={name}
				onChange={(event) => setName(event.target.value)}
				placeholder="Workspace name"
				disabled={busy}
				aria-invalid={!!error}
			/>
			{error && <p className="m-0 text-xs text-destructive">{error}</p>}
			<Button type="submit" disabled={busy} className="self-end">
				{busy ? "Creating…" : "Create Workspace"}
			</Button>
		</form>
	);
}
