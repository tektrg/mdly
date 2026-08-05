import { Modal } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
	CONTRAST_PREFERENCES,
	type ContrastPreference,
	type EditorFontPreference,
	SYSTEM_EDITOR_FONT_PREFERENCE,
	THEME_PREFERENCES,
	type ThemePreference,
} from "../lib/theme";
import {
	setContrastPreference,
	setEditorFontPreference,
	setShowIgnoredWorkspaceFiles,
	setThemePreference,
} from "../store/actions";
import {
	contrastPreferenceStore,
	editorFontPreferenceStore,
	showIgnoredWorkspaceFilesStore,
	themePreferenceStore,
} from "../store/state";

export function SettingsDialog({
	open,
	onOpenChange,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
}) {
	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="Settings"
			className="max-w-2xl"
		>
			<div className="flex flex-col gap-4">{children}</div>
		</Modal>
	);
}

export function SettingsSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h3 className="text-sm font-semibold">{title}</h3>
				{description ? (
					<p className="text-xs text-muted-foreground">{description}</p>
				) : null}
			</div>
			<div>{children}</div>
		</section>
	);
}

const themePreferenceLabels: Record<ThemePreference, string> = {
	system: "System",
	light: "Light",
	dark: "Dark",
};

const contrastPreferenceLabels: Record<ContrastPreference, string> = {
	soft: "Soft",
	standard: "Standard",
	crisp: "Crisp",
};

const segmentedControlItemClassName =
	"inline-flex h-7 min-w-14 items-center justify-center rounded-sm px-2 text-[11px] font-medium text-muted-foreground transition-[color,background-color,box-shadow] duration-[var(--default-transition-duration)] ease-snappy select-none peer-checked:bg-card peer-checked:text-foreground peer-focus-visible:ring-1 peer-focus-visible:ring-ring/40 peer-focus-visible:outline-hidden";

const fallbackEditorFontFamilies = [
	"Avenir Next",
	"Georgia",
	"Helvetica Neue",
	"Menlo",
	"Monaco",
	"New York",
	"SF Mono",
	"Times New Roman",
];

function contrastPreferenceFromSliderValue(value: string): ContrastPreference {
	const preference = CONTRAST_PREFERENCES[Number(value)];
	return preference ?? "standard";
}

function contrastPreferenceToSliderValue(preference: ContrastPreference) {
	return CONTRAST_PREFERENCES.indexOf(preference);
}

function normalizeFontFamilies(fontFamilies: string[]) {
	return [
		...new Set(fontFamilies.map((family) => family.trim()).filter(Boolean)),
	].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function useEditorFontFamilies(selectedFont: EditorFontPreference) {
	const [fontFamilies, setFontFamilies] = useState(() =>
		normalizeFontFamilies(fallbackEditorFontFamilies),
	);
	const [loading, setLoading] = useState(false);
	const [osFontsLoaded, setOsFontsLoaded] = useState(false);

	useEffect(() => {
		if (typeof window.queryLocalFonts !== "function") return;

		let cancelled = false;
		setLoading(true);
		void window
			.queryLocalFonts()
			.then((fonts) => {
				if (cancelled) return;
				const families = normalizeFontFamilies(
					fonts.map((font) => font.family),
				);
				if (families.length > 0) {
					setFontFamilies(families);
					setOsFontsLoaded(true);
				}
			})
			.catch(() => {
				// Keep the fallback list when the OS/browser denies font access.
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, []);

	return {
		fontFamilies: useMemo(() => {
			if (selectedFont === SYSTEM_EDITOR_FONT_PREFERENCE) return fontFamilies;
			if (osFontsLoaded) return fontFamilies;
			return normalizeFontFamilies([...fontFamilies, selectedFont]);
		}, [fontFamilies, osFontsLoaded, selectedFont]),
		loading,
		osFontsLoaded,
	};
}

export function AppearanceSettings() {
	const themePreference = useStoreValue(themePreferenceStore);
	const contrastPreference = useStoreValue(contrastPreferenceStore);
	const editorFontPreference = useStoreValue(editorFontPreferenceStore);
	const contrastLabel = contrastPreferenceLabels[contrastPreference];
	const {
		fontFamilies,
		loading: editorFontsLoading,
		osFontsLoaded,
	} = useEditorFontFamilies(editorFontPreference);

	useEffect(() => {
		if (!osFontsLoaded) return;
		if (editorFontPreference === SYSTEM_EDITOR_FONT_PREFERENCE) return;
		if (fontFamilies.includes(editorFontPreference)) return;
		setEditorFontPreference(SYSTEM_EDITOR_FONT_PREFERENCE);
	}, [editorFontPreference, fontFamilies, osFontsLoaded]);

	return (
		<SettingsSection title="Appearance">
			<div className="flex flex-wrap items-end gap-4">
				<fieldset className="inline-grid grid-cols-3 rounded-sm border border-border bg-muted/50 p-0.5">
					<legend className="sr-only">Theme</legend>
					{THEME_PREFERENCES.map((preference) => {
						return (
							<label
								className="relative inline-flex cursor-pointer"
								key={preference}
							>
								<input
									checked={preference === themePreference}
									className="peer sr-only"
									name="theme-preference"
									onChange={() => setThemePreference(preference)}
									type="radio"
									value={preference}
								/>
								<span className={segmentedControlItemClassName}>
									{themePreferenceLabels[preference]}
								</span>
							</label>
						);
					})}
				</fieldset>
				<label className="flex min-w-48 flex-col gap-1.5">
					<span className="flex items-center justify-between gap-3 text-[11px] font-medium text-muted-foreground">
						Contrast
						<output className="tabular-nums text-foreground">
							{contrastLabel}
						</output>
					</span>
					<input
						aria-valuetext={contrastLabel}
						className="h-7 w-48 cursor-pointer [accent-color:var(--ring)]"
						max={CONTRAST_PREFERENCES.length - 1}
						min={0}
						onChange={(event) =>
							setContrastPreference(
								contrastPreferenceFromSliderValue(event.currentTarget.value),
							)
						}
						step={1}
						type="range"
						value={contrastPreferenceToSliderValue(contrastPreference)}
					/>
					<span
						aria-hidden="true"
						className="grid w-48 grid-cols-3 text-[10px] leading-none text-muted-foreground"
					>
						<span>Soft</span>
						<span className="text-center">Standard</span>
						<span className="text-right">Crisp</span>
					</span>
				</label>
				<label className="flex min-w-64 flex-col gap-1.5">
					<span className="flex items-center justify-between gap-3 text-[11px] font-medium text-muted-foreground">
						Editor font
						{editorFontsLoading ? (
							<span className="font-normal">Loading</span>
						) : null}
					</span>
					<select
						className="h-8 w-64 rounded-sm border border-input bg-card px-2 text-[11px] text-foreground outline-hidden transition-[border-color,box-shadow] duration-[var(--default-transition-duration)] ease-snappy focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/40"
						onChange={(event) =>
							setEditorFontPreference(event.currentTarget.value)
						}
						value={editorFontPreference}
					>
						<option value={SYSTEM_EDITOR_FONT_PREFERENCE}>System</option>
						{fontFamilies.map((fontFamily) => (
							<option key={fontFamily} value={fontFamily}>
								{fontFamily}
							</option>
						))}
					</select>
				</label>
			</div>
		</SettingsSection>
	);
}

export function WorkspaceSettings() {
	const showIgnoredWorkspaceFiles = useStoreValue(
		showIgnoredWorkspaceFilesStore,
	);

	return (
		<SettingsSection
			title="Workspace"
			description="Controls which workspace files appear in the sidebar."
		>
			<label className="flex items-start justify-between gap-4 rounded-sm border border-border bg-card [padding-block:0.625rem] [padding-inline:0.75rem]">
				<span className="flex min-w-0 flex-col gap-1">
					<span className="text-[11px] font-medium text-foreground">
						Show ignored files
					</span>
					<span className="text-[11px] leading-4 text-muted-foreground">
						Includes Markdown and HTML files ignored by .gitignore or .ignore.
					</span>
				</span>
				<input
					checked={showIgnoredWorkspaceFiles}
					className="mt-0.5 size-4 shrink-0 cursor-pointer [accent-color:var(--ring)]"
					onChange={(event) =>
						setShowIgnoredWorkspaceFiles(event.currentTarget.checked)
					}
					type="checkbox"
				/>
			</label>
		</SettingsSection>
	);
}
