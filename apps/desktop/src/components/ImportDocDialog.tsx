import { Button, Modal } from "@hubble.md/ui";
import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";
import type { ConverterStatus } from "../desktopApi/types";
import { importDocFile, importDocUrl } from "../fileActions";

export function ImportDocDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [status, setStatus] = useState<"idle" | "importing">("idle");
	const [converter, setConverter] = useState<ConverterStatus | null>(null);
	const [converterStatus, setConverterStatus] = useState<"idle" | "checking">("idle");
	const [url, setUrl] = useState("");
	const [error, setError] = useState<string | null>(null);

	const refreshConverter = useCallback(async () => {
		setConverterStatus("checking");
		try {
			setConverter(await desktopApi.docImportCheckConverter());
		} catch {
			setConverter({
				available: false,
				version: null,
				installHint: "Could not check anydoc availability.",
			});
		} finally {
			setConverterStatus("idle");
		}
	}, []);

	useEffect(() => {
		if (!open) {
			setStatus("idle");
			setConverter(null);
			setConverterStatus("idle");
			setUrl("");
			setError(null);
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		void refreshConverter();
	}, [open, refreshConverter]);

	if (!open) return null;

	const busy = status === "importing";
	const ready = converter?.available === true;

	async function chooseAndImport() {
		setStatus("importing");
		setError(null);
		try {
			const filePath = await desktopApi.openFilePicker({
				defaultPath: desktopApi.homeDir,
			});
			if (!filePath) {
				setStatus("idle");
				return;
			}
			await importDocFile(filePath);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setStatus("idle");
		}
	}

	async function importFromUrl() {
		const trimmed = url.trim();
		if (!trimmed) return;
		setStatus("importing");
		setError(null);
		try {
			await importDocUrl(trimmed);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setStatus("idle");
		}
	}

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="Import Document"
			className="max-w-md"
		>
			<div className="flex flex-col gap-4">
				<ConverterStatusPanel
					converter={converter}
					status={converterStatus}
					onRefresh={() => void refreshConverter()}
				/>

				<div className="flex flex-col gap-2">
					<label className="text-[11px] font-medium text-muted-foreground">
						Share link or document URL
					</label>
					<div className="flex gap-2">
						<input
							className="h-8 w-full rounded-sm border border-input bg-card px-2 text-xs text-foreground outline-hidden placeholder:text-muted-foreground disabled:opacity-50"
							disabled={!ready || busy}
							placeholder="https://…/shared-document.docx"
							type="url"
							value={url}
							onChange={(event) => setUrl(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && url.trim()) {
									void importFromUrl();
								}
							}}
						/>
						<Button
							size="sm"
							disabled={!ready || busy || !url.trim()}
							onClick={() => void importFromUrl()}
						>
							Import
						</Button>
					</div>
					<p className="m-0 text-[11px] text-muted-foreground">
						Works for anonymous share links. Login-gated links need a manual
						download.
					</p>
				</div>

				{error ? (
					<p className="m-0 text-sm text-destructive">{error}</p>
				) : null}

				<div className="flex items-center justify-end gap-2">
					<Button
						size="sm"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						disabled={busy || !ready}
						onClick={() => void chooseAndImport()}
					>
						{busy ? "Importing..." : "Choose File"}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function ConverterStatusPanel({
	converter,
	status,
	onRefresh,
}: {
	converter: ConverterStatus | null;
	status: "idle" | "checking";
	onRefresh: () => void;
}) {
	const available = converter?.available === true;

	return (
		<div className="rounded-sm border border-border bg-muted/30 px-2 py-2 text-xs">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<p className="m-0 font-medium">
						{available
							? "anydoc ready"
							: converter
								? "anydoc not found"
								: "Checking anydoc..."}
					</p>
					<p className="m-0 mt-0.5 text-muted-foreground">
						{converter
							? available
								? converter.version
									? `anydoc ${converter.version}`
									: "anydoc installed"
								: converter.installHint
							: "Checking converter availability"}
					</p>
				</div>
				<Button
					disabled={status === "checking"}
					size="sm"
					variant="outline"
					onClick={onRefresh}
				>
					Check
				</Button>
			</div>
		</div>
	);
}