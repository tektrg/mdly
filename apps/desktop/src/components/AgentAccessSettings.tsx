import { Button } from "@hubble.md/ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import { desktopApi } from "../desktopApi";
import { setupWebmcpBridge, teardownWebmcpBridge } from "../webmcp";
import { SettingsSection } from "./SettingsDialog";

/**
 * Mirrors the resolved shape of `desktopApi.getAgentAccessState()`. Declared
 * locally rather than imported from `desktopApi/types.ts` because that file's
 * agent-access additions are landing in a separate, concurrent edit -- see
 * the identical note in `../webmcp.ts`, which mirrors the same shape.
 */
interface AgentAccessState {
	enabled: boolean;
	mcpUrl: string | null;
	connectCommand: string | null;
}

/**
 * The two agent-access methods this component calls. `setAgentAccessEnabled`
 * returns the fresh state (mirroring `enableCloudSync`/`disableCloudSync` in
 * this same Settings dialog) so flipping the toggle never needs a second
 * round trip just to learn the new `connectCommand`.
 */
interface AgentAccessDesktopApi {
	getAgentAccessState: () => Promise<AgentAccessState>;
	setAgentAccessEnabled: (enabled: boolean) => Promise<AgentAccessState>;
}

// `desktopApi`'s exported type (`DesktopApi`) doesn't carry these methods yet
// in this checkout -- cast once here rather than scattering `as unknown as`
// through the component body.
const agentAccessApi = desktopApi as unknown as AgentAccessDesktopApi;

/**
 * Slice 4's Settings surface for "Plug B" (docs/plans/local-doc-comments.md):
 * the single on/off switch that gates the WebMCP tool surface in
 * `../webmcp.ts`, plus the connect command for wiring an external agent
 * (e.g. Claude Code) to the local relay. Flipping the switch takes effect
 * immediately -- no app restart -- because it directly calls
 * `setupWebmcpBridge`/`teardownWebmcpBridge` rather than just persisting a
 * preference for next launch.
 */
export function AgentAccessSettings() {
	const [state, setState] = useState<AgentAccessState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		agentAccessApi
			.getAgentAccessState()
			.then((next) => {
				if (!cancelled) setState(next);
			})
			.catch((caught) => {
				if (!cancelled) {
					setError(caught instanceof Error ? caught.message : String(caught));
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const handleToggle = async (nextEnabled: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const next = await agentAccessApi.setAgentAccessEnabled(nextEnabled);
			setState(next);
			// The toggle must genuinely gate the tool surface, not just persist a
			// preference for next launch -- flip the live bridge in lockstep.
			if (nextEnabled) {
				await setupWebmcpBridge();
			} else {
				teardownWebmcpBridge();
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	};

	const copyConnectCommand = async (command: string) => {
		try {
			await navigator.clipboard.writeText(command);
			toast.success("Command copied");
		} catch {
			toast.error("Failed to copy command");
		}
	};

	// Defaults to checked (D5-style opt-out, not opt-in) before the initial
	// fetch resolves, matching the backend default of "on" -- but stays
	// disabled until we actually know the real state, so a click can't race
	// an assumed default.
	const enabled = state?.enabled ?? true;

	return (
		<SettingsSection
			title="AI agents"
			description="Lets an AI agent read and comment on your notes. Agents can never edit a note's text."
		>
			<div className="flex flex-col gap-2">
				<label className="flex items-start justify-between gap-4 rounded-sm border border-border bg-card [padding-block:0.625rem] [padding-inline:0.75rem]">
					<span className="flex min-w-0 flex-col gap-1">
						<span className="text-[11px] font-medium text-foreground">
							Allow AI agents to read and comment on this workspace
						</span>
					</span>
					<input
						checked={enabled}
						className="mt-0.5 size-4 shrink-0 cursor-pointer [accent-color:var(--ring)]"
						disabled={busy || state === null}
						onChange={(event) => void handleToggle(event.currentTarget.checked)}
						type="checkbox"
					/>
				</label>
				{state?.enabled && state.connectCommand ? (
					<div className="flex flex-col gap-1">
						<div className="flex items-start gap-2 rounded-sm border border-border bg-muted/40 p-2">
							<input
								aria-label="Connect command"
								className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-hidden"
								onFocus={(event) => event.currentTarget.select()}
								readOnly
								value={state.connectCommand}
							/>
							<Button
								aria-label="Copy connect command"
								onClick={() => {
									const command = state.connectCommand;
									if (command) void copyConnectCommand(command);
								}}
								size="icon-sm"
								variant="ghost"
							>
								<MingcuteCopy2Line />
							</Button>
						</div>
						<span className="text-[11px] leading-4 text-muted-foreground">
							Paste this in a terminal to connect Claude Code.
						</span>
					</div>
				) : null}
				{error ? (
					<span className="text-[11px] leading-4 text-destructive">
						{error}
					</span>
				) : null}
			</div>
		</SettingsSection>
	);
}
