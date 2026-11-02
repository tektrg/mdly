/**
 * Renderer-side `ViewStore` adapters (saved views R11, R25). The desktop one
 * forwards to the Electron main process, which owns `<workspace>/.hubble/views.json`
 * (`electron/workspaceViewsFile.ts`); the browser one keeps the same contract
 * over `localStorage`, so no file code reaches a web build.
 */
import {
	parseViewsFile,
	serializeViewsFile,
	type ViewStore,
	type ViewStoreReadResult,
} from "@tektrg/table-core";
import type { DesktopApi } from "../desktopApi/types";

type ViewsApi = Pick<
	DesktopApi,
	"readWorkspaceViews" | "writeWorkspaceViews" | "resetCorruptWorkspaceViews"
>;

export function createDesktopViewStore(
	api: ViewsApi,
	workspacePath: string,
): Required<ViewStore> {
	return {
		read: () => api.readWorkspaceViews(workspacePath),
		write: (file, expected) =>
			api.writeWorkspaceViews(workspacePath, file, expected),
		resetCorrupt: (file) => api.resetCorruptWorkspaceViews(workspacePath, file),
	};
}

export const LOCAL_VIEWS_KEY_PREFIX = "mdly.savedViews.v1:";

/** Same contract over a `Storage`; the snapshot is the stored string itself. */
export function createLocalStorageViewStore(
	storage: Pick<Storage, "getItem" | "setItem">,
	workspacePath: string,
	now: () => Date = () => new Date(),
): Required<ViewStore> {
	const key = `${LOCAL_VIEWS_KEY_PREFIX}${workspacePath}`;
	const readRaw = (): string | null => storage.getItem(key);
	const classify = (text: string): ViewStoreReadResult => {
		const parsed = parseViewsFile(text);
		return parsed.status === "ok"
			? { ...parsed, snapshot: text }
			: { status: "corrupt", reasons: parsed.reasons, snapshot: text };
	};
	const put = (text: string) => {
		try {
			storage.setItem(key, text);
			return { status: "ok" as const, snapshot: text };
		} catch (error) {
			return { status: "error" as const, error: String(error) };
		}
	};
	return {
		async read() {
			try {
				const raw = readRaw();
				return raw === null ? { status: "missing" } : classify(raw);
			} catch (error) {
				return { status: "unreadable", error: String(error) };
			}
		},
		async write(file, expected) {
			const raw = readRaw();
			if (raw !== expected) return { status: "conflict" };
			if (raw !== null && classify(raw).status !== "ok") {
				return { status: "conflict" };
			}
			return put(serializeViewsFile(file));
		},
		async resetCorrupt(file) {
			const raw = readRaw();
			if (raw !== null) {
				if (classify(raw).status === "ok") return { status: "conflict" };
				try {
					storage.setItem(`${key}.corrupt-${now().toISOString()}`, raw);
				} catch (error) {
					return { status: "error", error: String(error) };
				}
			}
			return put(serializeViewsFile(file));
		},
	};
}
