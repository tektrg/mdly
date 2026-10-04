import { useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";
import type {
	FilesScope,
	FilesScopeCounts,
	FilesScopeRule,
	WorkspaceFilesScopeState,
} from "../desktopApi/types";
import { refreshFiles } from "../store/actions";
import { showIgnoredWorkspaceFilesStore } from "../store/state";

const COUNT_DEBOUNCE_MS = 300;

const checkboxClassName =
	"size-4 shrink-0 cursor-pointer [accent-color:var(--ring)] disabled:cursor-not-allowed disabled:opacity-40";
const buttonClassName =
	"h-7 shrink-0 rounded-sm border border-input bg-card px-2.5 text-[11px] text-foreground outline-hidden disabled:opacity-50";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatCount(count: number | null, label: string): string {
	return count === null ? `too many to count ${label}` : `${count} ${label}`;
}

/** Unchecking "In app" forces "Synced" off: sync can never reach a file the app hides. */
function toggledRule(
	rule: FilesScopeRule,
	column: "inApp" | "synced",
	checked: boolean,
): FilesScopeRule {
	if (column === "inApp")
		return { ...rule, inApp: checked, synced: checked && rule.synced };
	return { ...rule, synced: rule.inApp && checked };
}

function useFilesScopeCounts(workspacePath: string, scope: FilesScope | null) {
	const [counts, setCounts] = useState<FilesScopeCounts | null>(null);
	useEffect(() => {
		if (!scope) return;
		let cancelled = false;
		setCounts(null);
		const timer = setTimeout(() => {
			void desktopApi
				.countFilesInScope(workspacePath, scope)
				.then((next) => {
					if (!cancelled) setCounts(next);
				})
				.catch(() => {
					if (!cancelled) setCounts({ visible: null, synced: null });
				});
		}, COUNT_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [workspacePath, scope]);
	return counts;
}

/**
 * Settings → Files: one rule list per workspace. Each row is a
 * gitignore-style pattern with "In app" (sidebar, document table, Cmd+P)
 * and "Synced" (Cloud Sync). Every change saves immediately.
 */
export function FilesScopeSettings({
	workspacePath,
}: {
	workspacePath: string;
}) {
	const [state, setState] = useState<WorkspaceFilesScopeState | null>(null);
	const [newPattern, setNewPattern] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const counts = useFilesScopeCounts(workspacePath, state?.scope ?? null);

	useEffect(() => {
		let cancelled = false;
		setState(null);
		void desktopApi
			.getFilesScope(workspacePath, showIgnoredWorkspaceFilesStore.get())
			.then((loaded) => {
				if (!cancelled) setState(loaded);
			})
			.catch((loadError: unknown) => {
				if (!cancelled) setError(errorText(loadError));
			});
		return () => {
			cancelled = true;
		};
	}, [workspacePath]);

	if (!state) {
		return error ? (
			<p className="text-[11px] text-destructive">{error}</p>
		) : null;
	}

	const persist = async (nextScope: FilesScope) => {
		const previous = state;
		setState({ ...state, scope: nextScope, isCustomized: true });
		setError(null);
		setNotice(null);
		try {
			const saved = await desktopApi.setFilesScope(workspacePath, nextScope);
			setState((current) => (current ? { ...current, scope: saved } : current));
			void refreshFiles(workspacePath);
		} catch (saveError) {
			setState(previous);
			setError(errorText(saveError));
		}
	};

	const updateRule = (index: number, nextRule: FilesScopeRule | null) => {
		const rules = state.scope.rules.flatMap((rule, ruleIndex) =>
			ruleIndex !== index ? [rule] : nextRule ? [nextRule] : [],
		);
		void persist({ ...state.scope, rules });
	};

	const addRule = () => {
		const pattern = newPattern.trim();
		if (!pattern) return;
		if (state.scope.rules.some((rule) => rule.pattern === pattern)) {
			setError(`"${pattern}" is already in the list.`);
			return;
		}
		setNewPattern("");
		void persist({
			...state.scope,
			rules: [...state.scope.rules, { pattern, inApp: false, synced: false }],
		});
	};

	const saveAsDefault = async () => {
		setError(null);
		try {
			await desktopApi.saveFilesScopeDefaults(state.scope);
			setNotice("Saved as the default for workspaces without their own list.");
		} catch (saveError) {
			setError(errorText(saveError));
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<label className="flex items-start justify-between gap-4 rounded-sm border border-border bg-card [padding-block:0.625rem] [padding-inline:0.75rem]">
				<span className="flex min-w-0 flex-col gap-1">
					<span className="text-[11px] font-medium text-foreground">
						Respect .gitignore
					</span>
					<span className="text-[11px] leading-4 text-muted-foreground">
						Hides files ignored by .gitignore or .ignore from the app. Cloud
						Sync never uploads them either way.
					</span>
				</span>
				<input
					checked={state.scope.respectGitignore}
					className={`mt-0.5 ${checkboxClassName}`}
					onChange={(event) =>
						void persist({
							...state.scope,
							respectGitignore: event.currentTarget.checked,
						})
					}
					type="checkbox"
				/>
			</label>

			<div className="flex flex-col rounded-sm border border-border bg-card">
				<div className="grid grid-cols-[1fr_3.5rem_3.5rem_1.5rem] items-center gap-2 border-b border-border text-[11px] font-medium text-muted-foreground [padding-block:0.375rem] [padding-inline:0.75rem]">
					<span>Pattern</span>
					<span className="text-center">In app</span>
					<span className="text-center">Synced</span>
					<span />
				</div>
				{state.builtInPatterns.map((pattern) => (
					<div
						className="grid grid-cols-[1fr_3.5rem_3.5rem_1.5rem] items-center gap-2 text-[11px] text-muted-foreground [padding-block:0.25rem] [padding-inline:0.75rem]"
						key={`built-in:${pattern}`}
						title="Built in — always hidden and never synced"
					>
						<code className="truncate">{pattern}</code>
						<input
							aria-label={`${pattern} in app`}
							checked={false}
							className={`justify-self-center ${checkboxClassName}`}
							disabled
							readOnly
							type="checkbox"
						/>
						<input
							aria-label={`${pattern} synced`}
							checked={false}
							className={`justify-self-center ${checkboxClassName}`}
							disabled
							readOnly
							type="checkbox"
						/>
						<span aria-hidden className="text-center">
							🔒
						</span>
					</div>
				))}
				{state.scope.rules.map((rule, index) => (
					<div
						className="grid grid-cols-[1fr_3.5rem_3.5rem_1.5rem] items-center gap-2 text-[11px] text-foreground [padding-block:0.25rem] [padding-inline:0.75rem]"
						key={rule.pattern}
					>
						<code className="truncate">{rule.pattern}</code>
						<input
							aria-label={`${rule.pattern} in app`}
							checked={rule.inApp}
							className={`justify-self-center ${checkboxClassName}`}
							onChange={(event) =>
								updateRule(
									index,
									toggledRule(rule, "inApp", event.currentTarget.checked),
								)
							}
							type="checkbox"
						/>
						<input
							aria-label={`${rule.pattern} synced`}
							checked={rule.synced}
							className={`justify-self-center ${checkboxClassName}`}
							disabled={!rule.inApp}
							onChange={(event) =>
								updateRule(
									index,
									toggledRule(rule, "synced", event.currentTarget.checked),
								)
							}
							title={rule.inApp ? undefined : "Hidden files are never synced"}
							type="checkbox"
						/>
						<button
							aria-label={`Remove ${rule.pattern}`}
							className="text-muted-foreground hover:text-foreground"
							onClick={() => updateRule(index, null)}
							type="button"
						>
							×
						</button>
					</div>
				))}
				<form
					className="flex items-center gap-2 border-t border-border [padding-block:0.375rem] [padding-inline:0.75rem]"
					onSubmit={(event) => {
						event.preventDefault();
						addRule();
					}}
				>
					<input
						aria-label="New pattern"
						className="h-7 min-w-0 flex-1 rounded-sm border border-input bg-background px-2 text-[11px] text-foreground outline-hidden"
						onChange={(event) => setNewPattern(event.currentTarget.value)}
						placeholder="Folder name, path (fe/docs) or glob (*.log)"
						spellCheck={false}
						value={newPattern}
					/>
					<button className={buttonClassName} type="submit">
						Add
					</button>
				</form>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="text-[11px] text-muted-foreground tabular-nums">
					{counts
						? `${formatCount(counts.visible, "visible")} · ${formatCount(counts.synced, "synced")}`
						: "Counting…"}
				</span>
				<button
					className={buttonClassName}
					onClick={() => void saveAsDefault()}
					type="button"
				>
					Use as default for new workspaces
				</button>
			</div>
			<span className="text-[11px] leading-4 text-muted-foreground">
				A bare name matches at any depth; a path like fe/docs or /dist is
				anchored to the workspace root; globs like *.log follow .gitignore
				rules. New rows start hidden — tick In app to show them.
			</span>
			{notice && (
				<span className="text-[11px] text-muted-foreground">{notice}</span>
			)}
			{error && <span className="text-[11px] text-destructive">{error}</span>}
		</div>
	);
}
