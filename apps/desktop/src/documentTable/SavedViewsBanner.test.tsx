// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { workspacePathStore } from "../store/state";
import {
	loadWorkspaceSavedViews,
	setViewStoreFactoryForTest,
} from "./documentViewsFileStore";
import { SavedViewsBanner } from "./SavedViewsBanner";
import { createLocalStorageViewStore } from "./viewStores";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	setViewStoreFactoryForTest(null);
	document.body.innerHTML = "";
});

describe("SavedViewsBanner (R18)", () => {
	it("shows a visible warning for a corrupt views file", async () => {
		const map = new Map([["mdly.savedViews.v1:/bad", "{bad"]]);
		const storage = {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
		};
		setViewStoreFactoryForTest((ws) =>
			createLocalStorageViewStore(storage, ws),
		);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			workspacePathStore.set("/bad");
			await loadWorkspaceSavedViews("/bad");
			root.render(<SavedViewsBanner />);
		});
		const banner = host.querySelector('[data-testid="saved-views-banner"]');
		expect(banner?.getAttribute("data-notice")).toBe("corrupt");
		expect(banner?.textContent).toContain("can't be read");
		expect(map.get("mdly.savedViews.v1:/bad")).toBe("{bad");
		act(() => root.unmount());
	});
});
