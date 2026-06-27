import { Modal } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import type { ReactNode } from "react";
import {
	CONTRAST_PREFERENCES,
	type ContrastPreference,
	THEME_PREFERENCES,
	type ThemePreference,
} from "../lib/theme";
import { setContrastPreference, setThemePreference } from "../store/actions";
import { contrastPreferenceStore, themePreferenceStore } from "../store/state";

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

function contrastPreferenceFromSliderValue(value: string): ContrastPreference {
	const preference = CONTRAST_PREFERENCES[Number(value)];
	return preference ?? "standard";
}

function contrastPreferenceToSliderValue(preference: ContrastPreference) {
	return CONTRAST_PREFERENCES.indexOf(preference);
}

export function AppearanceSettings() {
	const themePreference = useStoreValue(themePreferenceStore);
	const contrastPreference = useStoreValue(contrastPreferenceStore);
	const contrastLabel = contrastPreferenceLabels[contrastPreference];

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
								<span className="inline-flex h-7 min-w-14 items-center justify-center rounded-sm px-2 text-[11px] font-medium text-muted-foreground transition-[color,background-color,box-shadow] duration-[var(--default-transition-duration)] ease-snappy select-none peer-checked:bg-card peer-checked:text-foreground peer-focus-visible:ring-1 peer-focus-visible:ring-ring/40 peer-focus-visible:outline-hidden">
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
			</div>
		</SettingsSection>
	);
}
