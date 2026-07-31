// Local draft storage for linked Notion pages, keyed by Notion page id.
// v1 keeps drafts in IndexedDB (no ~5MB localStorage cap). A future cloud
// implementation can satisfy the same DraftStore interface.
import { notionMarkdownContentHash } from "../notion/contentHash";
import { stripNotionLinkMetadata } from "../notion/notionMarkdown";

export type Draft = {
	/** Missing on drafts persisted before this field existed — treat as "page". */
	kind?: "page" | "database";
	pageId: string;
	title: string;
	url: string | null;
	/** Only set when kind === "database"; which Notion API shape to re-query. */
	objectType?: "database" | "data_source";
	/** Full local markdown incl. the Hubble `notion:` frontmatter block. Empty for databases. */
	markdown: string;
	/**
	 * Remote page body (no frontmatter) captured at last fetch/push. Used as the
	 * baseline for building a minimal targeted diff on push. Empty for databases.
	 */
	syncedBody: string;
	/**
	 * Content hash of the remote markdown (as fetched, incl. any Notion property
	 * frontmatter) at last sync. Compared against the local content to detect
	 * local edits without being fooled by rotated signed media URLs. Empty for databases.
	 */
	syncedContentHash: string;
	updatedAt: number;
};

export interface DraftStore {
	list(): Promise<Draft[]>;
	get(pageId: string): Promise<Draft | null>;
	put(draft: Draft): Promise<void>;
	remove(pageId: string): Promise<void>;
}

const DB_NAME = "mdly-drafts";
const STORE = "drafts";

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) {
				db.createObjectStore(STORE, { keyPath: "pageId" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function tx<T>(
	db: IDBDatabase,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE, mode);
		const request = run(transaction.objectStore(STORE));
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export const indexedDbDraftStore: DraftStore = {
	async list() {
		const db = await openDb();
		const all = await tx<Draft[]>(
			db,
			"readonly",
			(store) => store.getAll() as IDBRequest<Draft[]>,
		);
		return all.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	async get(pageId) {
		const db = await openDb();
		const draft = await tx<Draft | undefined>(
			db,
			"readonly",
			(store) => store.get(pageId) as IDBRequest<Draft | undefined>,
		);
		return draft ?? null;
	},
	async put(draft) {
		const db = await openDb();
		await tx(db, "readwrite", (store) => store.put(draft));
	},
	async remove(pageId) {
		const db = await openDb();
		await tx(db, "readwrite", (store) => store.delete(pageId));
	},
};

/** Hash of the local content in a form comparable to the remote baseline. */
export function comparableContentHash(markdown: string): string {
	return notionMarkdownContentHash(stripNotionLinkMetadata(markdown));
}

/** True when the local markdown differs from the Notion baseline. Databases have no markdown to diff. */
export function hasLocalChanges(draft: Draft): boolean {
	if (draft.kind === "database") return false;
	return comparableContentHash(draft.markdown) !== draft.syncedContentHash;
}
