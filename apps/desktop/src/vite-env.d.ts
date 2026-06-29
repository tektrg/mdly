/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/react" />

import type { DesktopApi } from "./desktopApi/types";

declare global {
	type QueryLocalFontData = {
		family: string;
		fullName: string;
		postscriptName: string;
		style: string;
	};

	interface Window {
		desktopApi: DesktopApi;
		queryLocalFonts?: () => Promise<QueryLocalFontData[]>;
	}
}
