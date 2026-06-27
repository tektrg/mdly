// @vitest-environment happy-dom
import { act, type ButtonHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotionDatabaseViewer } from "./NotionDatabaseViewer";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const queryNotionDatabase = vi.hoisted(() => vi.fn());

vi.mock("../desktopApi", () => ({
	desktopApi: {
		queryNotionDatabase,
	},
}));

vi.mock("../fileActions", () => ({
	openOrImportNotionPage: vi.fn(),
}));

vi.mock("@hubble.md/ui", () => ({
	Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button type="button" {...props}>
			{children}
		</button>
	),
}));

const databaseMetadata = {
	object: "data_source" as const,
	sourceId: "source-id",
	account: "7lab",
	url: "https://notion.so/source-id",
	title: "Roadmap",
	sync: "read_only" as const,
	pageSize: 25,
};

type DatabaseMetadata = typeof databaseMetadata;

const firstPageQuery = {
	sourceId: "source-id",
	columns: ["Status"],
	hasMore: true,
	nextCursor: "cursor-2",
	rows: [
		{
			pageId: "page-1",
			title: "First row",
			url: "https://notion.so/page-1",
			lastEditedTime: "2026-06-25T00:00:00.000Z",
			properties: { Status: "Active" },
		},
	],
};

const secondPageQuery = {
	sourceId: "source-id",
	columns: ["Status"],
	hasMore: false,
	nextCursor: null,
	rows: [
		{
			pageId: "page-2",
			title: "Second row",
			url: "https://notion.so/page-2",
			lastEditedTime: "2026-06-25T00:00:00.000Z",
			properties: { Status: "Done" },
		},
	],
};

describe("NotionDatabaseViewer", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		queryNotionDatabase.mockReset();
		queryNotionDatabase.mockResolvedValue(firstPageQuery);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("does not refresh when the same open re-renders with new metadata identity", async () => {
		await renderDatabase({
			metadata: { ...databaseMetadata },
			refreshToken: 0,
		});

		expect(queryNotionDatabase).toHaveBeenCalledTimes(1);

		await renderDatabase({
			metadata: { ...databaseMetadata },
			refreshToken: 0,
		});

		expect(queryNotionDatabase).toHaveBeenCalledTimes(1);

		await renderDatabase({
			metadata: { ...databaseMetadata },
			refreshToken: 1,
		});

		expect(queryNotionDatabase).toHaveBeenCalledTimes(2);
	});

	it("fetches when the user pages through the database", async () => {
		queryNotionDatabase
			.mockResolvedValueOnce(firstPageQuery)
			.mockResolvedValueOnce(secondPageQuery);

		await renderDatabase({ metadata: databaseMetadata, refreshToken: 0 });

		const nextButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Next",
		);
		expect(nextButton).toBeTruthy();

		await act(async () => {
			nextButton?.click();
			await Promise.resolve();
		});

		expect(queryNotionDatabase).toHaveBeenCalledTimes(2);
		expect(queryNotionDatabase).toHaveBeenLastCalledWith({
			sourceId: "source-id",
			sourceObject: "data_source",
			account: "7lab",
			startCursor: "cursor-2",
			pageSize: 25,
		});
	});

	async function renderDatabase({
		metadata,
		refreshToken,
	}: {
		metadata: DatabaseMetadata;
		refreshToken: number;
	}) {
		await act(async () => {
			root.render(
				<NotionDatabaseViewer
					path="/workspace/roadmap.md"
					metadata={metadata}
					refreshToken={refreshToken}
				/>,
			);
			await Promise.resolve();
		});
	}
});
