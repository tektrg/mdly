import { Button, Modal } from "@hubble.md/ui";
import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";
import type { ConverterStatus } from "../desktopApi/types";
import { importDocFile } from "../fileActions";

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
			setError(null);
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		void refreshConverter();
	}, [open, refreshConverter]);

	if (!open) return null;

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
						disabled={status === "importing" || !converter?.available}
						onClick={() => void chooseAndImport()}
					>
						{status === "importing" ? "Importing..." : "Choose File"}
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