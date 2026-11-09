import { Button } from "@hubble.md/ui";
import type { DesktopUpdateState } from "../desktopApi/types";
import { SettingsSection } from "./SettingsDialog";

export function SidebarUpdateCallout({
	onInstall,
	onDismiss,
}: {
	onInstall: () => void;
	onDismiss: () => void;
}) {
	return (
		<div className="rounded-mdly-control bg-primary/8 p-3">
			<div className="flex flex-col gap-3">
				<div className="flex flex-col gap-1">
					<p className="text-[11px] text-foreground">
						<span className="font-semibold">A new version</span> is ready to
						install.
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" onClick={onInstall}>
						Restart
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

export function UpdatesSection({
	state,
	onPrimaryAction,
}: {
	state: DesktopUpdateState;
	onPrimaryAction: () => void;
}) {
	const button = getPrimaryButton(state);
	const secondaryText = getSecondaryText(state);

	return (
		<SettingsSection title="Updates">
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex min-w-0 flex-col gap-1">
						<p className="text-sm text-foreground">
							Current version {state.currentVersion}
						</p>
						{state.lastCheckedAt ? (
							<p className="text-xs text-muted-foreground">
								Last checked {formatUpdateTimestamp(state.lastCheckedAt)}
							</p>
						) : null}
					</div>
					<Button
						size="sm"
						variant={button.variant}
						disabled={button.disabled}
						onClick={onPrimaryAction}
					>
						{button.label}
					</Button>
				</div>
				{state.status === "error" && state.message ? (
					<p className="text-xs text-destructive">{state.message}</p>
				) : null}
				{secondaryText ? (
					<p className="text-xs text-muted-foreground">{secondaryText}</p>
				) : null}
			</div>
		</SettingsSection>
	);
}

function getPrimaryButton(state: DesktopUpdateState) {
	if (!state.isSupported) {
		return {
			label: "Updates Unavailable",
			disabled: true,
			variant: "outline" as const,
		};
	}

	switch (state.status) {
		case "idle":
		case "up-to-date":
			return {
				label: "Check for Updates",
				disabled: false,
				variant: "outline" as const,
			};
		case "checking":
			return {
				label: "Checking...",
				disabled: true,
				variant: "outline" as const,
			};
		case "downloading":
			return {
				label:
					state.progressPercent !== null
						? `Downloading ${Math.round(state.progressPercent)}%`
						: "Downloading...",
				disabled: true,
				variant: "outline" as const,
			};
		case "ready":
			return {
				label: "Restart to Update",
				disabled: false,
				variant: "default" as const,
			};
		case "error":
			return {
				label: "Retry Check",
				disabled: false,
				variant: "outline" as const,
			};
	}
}

function getSecondaryText(state: DesktopUpdateState) {
	if (!state.isSupported) {
		return state.message ?? "Updates are unavailable in this build.";
	}
	if (state.status === "downloading") {
		return state.availableVersion
			? `Version ${state.availableVersion} is downloading in the background.`
			: "A new release is downloading in the background.";
	}
	return "";
}

function formatUpdateTimestamp(value: number) {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(value);
}
