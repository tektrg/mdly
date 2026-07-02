import { Button, Modal } from "@hubble.md/ui";
import { toast } from "sonner";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import { desktopApi } from "../desktopApi";

const SKILLS_COMMAND = "npx skills add bholmesdev/hubble-skills";

/** Replaces the home dir prefix with ~ for a friendlier path. */
function toTildePath(absPath: string, homeDir: string): string {
	if (homeDir && (absPath === homeDir || absPath.startsWith(`${homeDir}/`))) {
		return `~${absPath.slice(homeDir.length)}`;
	}
	return absPath;
}

/** Quotes a path with spaces while keeping a leading ~ unquoted so it expands. */
function shellQuotePath(displayPath: string): string {
	if (!/\s/.test(displayPath)) return displayPath;
	if (displayPath.startsWith("~/")) return `~/"${displayPath.slice(2)}"`;
	return `"${displayPath}"`;
}

/**
 * Builds the install command, prefixed with a cd into the open folder. The
 * trailing `&&` keeps it a single command across two lines, so it stays
 * copy-pasteable while showing the npx line in full.
 */
function buildInstallCommand(workspacePath: string | null): string {
	if (!workspacePath) return SKILLS_COMMAND;
	const display = shellQuotePath(
		toTildePath(workspacePath, desktopApi.homeDir),
	);
	return `cd ${display} &&\n${SKILLS_COMMAND}`;
}

export function SidebarHtmlAppsCallout({
	onShowMore,
	onDismiss,
}: {
	onShowMore: () => void;
	onDismiss: () => void;
}) {
	return (
		<div className="rounded-md border border-primary/20 bg-primary/8 p-3">
			<div className="flex flex-col gap-3">
				<div className="flex flex-col gap-1">
					<p className="text-[11px] text-foreground">
						<span className="font-semibold">Turn notes into HTML Apps.</span>{" "}
						Install mdly skills for your agents to build live views from your
						notes.
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" onClick={onShowMore}>
						Show me more
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="text-foreground hover:bg-muted hover:text-foreground"
						onClick={onDismiss}
					>
						Dismiss
					</Button>
				</div>
			</div>
		</div>
	);
}

export function HtmlAppsDialog({
	open,
	onOpenChange,
	workspacePath,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspacePath: string | null;
}) {
	const command = buildInstallCommand(workspacePath);
	const copyCommand = async () => {
		try {
			await navigator.clipboard.writeText(command);
			toast.success("Command copied");
		} catch {
			toast.error("Failed to copy command");
		}
	};

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="HTML Apps"
			className="max-w-xl"
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-col gap-2">
					<p className="text-xs text-foreground">
						Turn your notes into <strong>live, interactive apps.</strong>{" "}
						Install the skills, then tell your coding agent what app you want to
						build. You can view the app directly in mdly with live reloading.
					</p>
					<div className="flex items-start gap-2 rounded-sm border border-border bg-muted/40 p-2">
						<code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-foreground">
							{command}
						</code>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Copy command"
							onClick={() => void copyCommand()}
						>
							<MingcuteCopy2Line />
						</Button>
					</div>
				</div>
				<video
					className="w-full rounded-[12px]"
					src="/html-apps-preview.mp4"
					autoPlay
					loop
					muted
					playsInline
				/>
			</div>
		</Modal>
	);
}
