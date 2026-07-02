import { Button } from "@hubble.md/ui";

export function WelcomeScreen({
	onCreateFolder,
	onOpenFolder,
}: {
	onCreateFolder: () => void;
	onOpenFolder: () => void;
}) {
	return (
		<div className="flex max-w-md flex-col items-center gap-3 text-center">
			<h2
				className="welcome-rise font-rounded text-3xl font-medium tracking-tight"
				style={{ animationDelay: "0.05s" }}
			>
				Welcome to <span className="font-semibold">mdly</span>
			</h2>
			<p
				className="welcome-rise mb-2 text-sm text-muted-foreground"
				style={{ animationDelay: "0.15s" }}
			>
				Let's pick a folder to start writing.
			</p>
			<div
				className="welcome-rise flex flex-wrap items-center justify-center gap-2"
				style={{ animationDelay: "0.25s" }}
			>
				<Button onClick={onCreateFolder}>Create new folder</Button>
				<Button variant="outline" onClick={onOpenFolder}>
					Open existing folder
				</Button>
			</div>
		</div>
	);
}
