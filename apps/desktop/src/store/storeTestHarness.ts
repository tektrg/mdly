import { vi } from "vitest";

/**
 * Shared Vitest harness for the store suites.
 *
 * Store actions capture `window.desktopApi` at import time, so every test has to
 * stub globals *before* importing the store modules. Both `actions.test.ts` and
 * `closeDocument.test.ts` need that dance, and a test file cannot import another
 * test file without re-registering its suites — hence a plain module.
 */
export type MockDesktopApi = {
	readFileText: ReturnType<typeof vi.fn>;
	writeFileText: ReturnType<typeof vi.fn>;
	listDirectory: ReturnType<typeof vi.fn>;
	readWorkspaceConfig: ReturnType<typeof vi.fn>;
	writeWorkspaceConfig: ReturnType<typeof vi.fn>;
	renameFile: ReturnType<typeof vi.fn>;
	renameSymlinkTarget: ReturnType<typeof vi.fn>;
	pathExists: ReturnType<typeof vi.fn>;
	openFolderPicker: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
};

export function createDesktopApi(): MockDesktopApi {
	return {
		readFileText: vi.fn(async () => "before"),
		writeFileText: vi.fn(async () => {}),
		listDirectory: vi.fn(async () => ({ files: [], folders: [] })),
		readWorkspaceConfig: vi.fn(async () => ({ version: 1, pinnedNotes: [] })),
		writeWorkspaceConfig: vi.fn(async () => {}),
		renameFile: vi.fn(async () => {}),
		renameSymlinkTarget: vi.fn(async () => {}),
		pathExists: vi.fn(async () => false),
		openFolderPicker: vi.fn(async () => undefined),
		deleteFile: vi.fn(async () => {}),
	};
}

/**
 * Actions capture window.desktopApi at import time, so each test stubs globals
 * before importing the store modules.
 */
export async function loadStoreActions(
	api: MockDesktopApi,
	persisted?: unknown,
) {
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: vi.fn(() => (persisted ? JSON.stringify(persisted) : null)),
		setItem: vi.fn(),
	});
	vi.stubGlobal("window", {
		desktopApi: api,
		setTimeout,
		clearTimeout,
	});

	const actions = await import("./actions");
	const state = await import("./state");
	const closeDocument = await import("./closeDocument");
	const docNavigationHistory = await import("./docNavigationHistory");
	return { ...actions, ...state, ...closeDocument, ...docNavigationHistory };
}
