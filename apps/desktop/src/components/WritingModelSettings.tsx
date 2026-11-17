/**
 * Settings → Writing tools: the local GGUF model path and the engine's
 * current state (idle / loading / ready / missing / failed), so a missing or
 * broken model is visible here rather than a silent no-op.
 */
import { useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";
import type { WritingEngineStatus } from "../desktopApi/types";
import { SettingsSection } from "./SettingsDialog";

const stateLabels: Record<WritingEngineStatus["state"], string> = {
	idle: "Not loaded yet (loads on first use)",
	loading: "Loading…",
	ready: "Ready",
	missing: "Model file not found",
	failed: "Failed",
};

export function WritingModelSettings() {
	const [status, setStatus] = useState<WritingEngineStatus | null>(null);
	const [draft, setDraft] = useState("");

	useEffect(() => {
		desktopApi
			.getWritingEngineStatus()
			.then((next) => {
				setStatus(next);
				setDraft(next.modelPath);
			})
			.catch(() => undefined);
	}, []);

	const save = async () => {
		const next = await desktopApi.setWritingModelPath(draft.trim());
		setStatus(next);
		setDraft(next.modelPath);
	};

	return (
		<SettingsSection
			title="Writing tools"
			description="Local model (GGUF) for the dot's quick tools. Clear the field to use the default."
		>
			<div className="flex flex-col gap-2">
				<div className="flex gap-2">
					<input
						className="h-8 min-w-0 flex-1 rounded-full bg-mdly-control px-3 text-[11px] text-foreground outline-hidden"
						value={draft}
						onChange={(event) => setDraft(event.currentTarget.value)}
						spellCheck={false}
						aria-label="Model path"
					/>
					<button
						type="button"
						className="h-8 rounded-full bg-mdly-control px-3 text-[11px]"
						onClick={() => void save()}
					>
						Save
					</button>
				</div>
				{status ? (
					<p
						className={`text-[11px] ${
							status.state === "missing" || status.state === "failed"
								? "text-destructive"
								: "text-muted-foreground"
						}`}
					>
						{stateLabels[status.state]}
						{status.error ? ` — ${status.error}` : ""}
					</p>
				) : null}
			</div>
		</SettingsSection>
	);
}
