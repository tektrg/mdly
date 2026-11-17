/**
 * Agent hook UI for the open note: a "watching" badge naming each live
 * `mdly watch` subscriber (and its machine), plus the explicit "Send edits to
 * agent" action — typing alone never wakes an agent. Hidden when nobody watches.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import type { AgentHookState } from "../desktopApi/types";

const POLL_MS = 5_000;

export type SendStatus = "idle" | "sending" | "failed";

export function watcherLabel(
	watchers: AgentHookState["watchers"],
): string | null {
	if (watchers.length === 0) return null;
	const names = watchers.map((w) => `${w.name} (${w.machine})`);
	return `${names.join(", ")} ${watchers.length === 1 ? "is" : "are"} watching`;
}

export function AgentHookBar({
	path,
	getMarkdown,
	watchers,
}: {
	path: string;
	getMarkdown: () => string;
	watchers: AgentHookState["watchers"];
}) {
	const [status, setStatus] = useState<SendStatus>("idle");
	const label = watcherLabel(watchers);
	const send = useCallback(async () => {
		setStatus("sending");
		try {
			const result = await desktopApi.agentHookSendEdits(path, getMarkdown());
			setStatus("idle");
			toast.success(
				result.status === "sent"
					? `Sent ${result.changes} change${result.changes === 1 ? "" : "s"} to the agent`
					: "No edits since the agent's last look",
			);
		} catch (error) {
			setStatus("failed");
			toast.error("Could not send edits", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}, [path, getMarkdown]);
	if (!label) return null;
	return (
		<div
			className="fixed z-40 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm"
			style={{ insetBlockEnd: 12, insetInlineEnd: 12 }}
			data-testid="agent-hook-bar"
		>
			<span aria-hidden className="size-2 rounded-full bg-emerald-500" />
			<span>{label}</span>
			<button
				type="button"
				className="rounded-full bg-primary px-2 py-0.5 text-primary-foreground disabled:opacity-60"
				disabled={status === "sending"}
				onClick={() => void send()}
			>
				{status === "sending"
					? "Sending…"
					: status === "failed"
						? "Retry send"
						: "Send edits to agent"}
			</button>
		</div>
	);
}

/**
 * Polls (and listens for) the note's watchers and pending agent proposals,
 * and reports the note as open while mounted (the "open files" watch scope).
 */
export function useAgentHookState(
	path: string,
	enabled: boolean,
): AgentHookState {
	const [state, setState] = useState<AgentHookState>({
		proposals: [],
		watchers: [],
	});
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		void desktopApi.agentHookDocOpen(path, true).catch(() => undefined);
		const refresh = () =>
			desktopApi
				.agentHookState(path)
				.then((next) => {
					if (active) setState(next);
				})
				.catch(() => undefined);
		void refresh();
		const timer = setInterval(refresh, POLL_MS);
		const unsubscribe = desktopApi.onAgentHookChanged((changed) => {
			if (changed === path) void refresh();
		});
		return () => {
			active = false;
			void desktopApi.agentHookDocOpen(path, false).catch(() => undefined);
			clearInterval(timer);
			unsubscribe();
		};
	}, [path, enabled]);
	return state;
}
