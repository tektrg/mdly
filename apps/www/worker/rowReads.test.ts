import { describe, expect, it } from "vitest";
import {
	approximateWorkspaceBytes,
	ensureBytesCounter,
	ensureSchema,
} from "./durableObject/schema.js";
import {
	assertCommentLogSlotInvariant,
	softDeleteFile,
	upsertFile,
} from "./durableObject/files.js";

/**
 * BUG-LW1 proof: pushing N files must read O(N) rows, not O(N²).
 *
 * Why a fake instead of the live stack: the vitest-pool-workers DO gives no
 * access to per-query row-read counts, and DO billing is what blew up. This
 * fake implements exactly the SQL the real `schema.ts`/`files.ts` issue (and
 * counts rows the way the DO free tier does: a full-table scan costs one row
 * read per table row, a primary-key point lookup costs one, a computed
 * `SELECT LENGTH(?)` costs zero). The assertions that matter:
 * - the full-scan `SUM(LENGTH(content))` query runs exactly ONCE no matter
 *   how many files are pushed (before the fix it ran on EVERY push);
 * - total rows read grows linearly (bound N*5; quadratic would be ~N²/2);
 * - the counter always equals the true `SUM(LENGTH(content))`, including
 *   non-BMP text where JS `.length` and SQLite `LENGTH()` disagree.
 */

type FileEntry = {
	content: string;
	deleted: number;
};

/** SQLite LENGTH() counts Unicode code points, not UTF-16 code units. */
function sqliteLength(s: string): number {
	return [...s].length;
}

function cursor<T>(rows: T[]) {
	return {
		one(): T {
			if (rows.length !== 1)
				throw new Error(`expected 1 row, got ${rows.length}`);
			return rows[0] as T;
		},
		toArray(): T[] {
			return [...rows];
		},
		[Symbol.iterator]() {
			return rows[Symbol.iterator]();
		},
	};
}

class FakeSql {
	rowsRead = 0;
	fullScans = 0;
	files = new Map<string, FileEntry>();
	meta = new Map<string, number>();
	devices = new Map<string, number>();

	get sql(): SqlStorage {
		return { exec: this.exec } as unknown as SqlStorage;
	}

	exec = (query: string, ...params: unknown[]) => {
		const q = query.replace(/\s+/g, " ").trim();
		const u = q.toUpperCase();

		if (
			u.startsWith("CREATE TABLE") ||
			u.startsWith("CREATE INDEX")
		) {
			return cursor([]);
		}

		if (u.startsWith("INSERT OR IGNORE INTO META")) {
			// ensureSchema's literal form: ... VALUES ('<key>', <n>)
			const m = /VALUES \('([^']+)', (-?\d+)\)/i.exec(q);
			if (m && !this.meta.has(m[1] as string))
				this.meta.set(m[1] as string, Number(m[2]));
			return cursor([]);
		}

		if (u.startsWith("SELECT VALUE FROM META WHERE KEY = 'VERSION'")) {
			this.rowsRead += 1;
			return cursor([{ value: this.meta.get("version") ?? 0 }]);
		}

		if (u.startsWith("SELECT VALUE FROM META WHERE KEY = 'BYTES'")) {
			this.rowsRead += 1;
			const v = this.meta.get("bytes");
			return cursor(v === undefined ? [] : [{ value: v }]);
		}

		if (u.includes("SUM(LENGTH(CONTENT))")) {
			this.fullScans += 1;
			this.rowsRead += this.files.size;
			let total: number | null = null;
			for (const f of this.files.values()) {
				if (f.deleted === 0) total = (total ?? 0) + sqliteLength(f.content);
			}
			return cursor([{ total }]);
		}

		if (u.startsWith("INSERT INTO META")) {
			// ensureBytesCounter's backfill persist: only fills when still -1.
			const total = params[0] as number;
			if (!this.meta.has("bytes")) this.meta.set("bytes", total);
			else if (this.meta.get("bytes") === -1) this.meta.set("bytes", total);
			return cursor([]);
		}

		if (u.startsWith("UPDATE META SET VALUE = VALUE +")) {
			const delta = params[0] as number;
			this.meta.set("bytes", (this.meta.get("bytes") ?? 0) + delta);
			return cursor([]);
		}

		if (u.startsWith("SELECT LENGTH(CONTENT) AS LEN, DELETED FROM FILES")) {
			this.rowsRead += 1; // primary-key point lookup
			const entry = this.files.get(params[0] as string);
			return cursor(
				entry
					? [{ len: sqliteLength(entry.content), deleted: entry.deleted }]
					: [],
			);
		}

		if (u.startsWith("INSERT INTO FILES")) {
			const path = params[0] as string;
			const content = params[2] as string;
			this.files.set(path, { content, deleted: 0 });
			return cursor([]);
		}

		if (u.startsWith("SELECT LENGTH(?) AS LEN")) {
			// Pure computation over a bound param — zero table rows read.
			return cursor([{ len: sqliteLength(params[0] as string) }]);
		}

		if (u.startsWith("UPDATE FILES SET DELETED = 1")) {
			const path = params[2] as string;
			const entry = this.files.get(path);
			if (entry) entry.deleted = 1;
			return cursor([]);
		}

		if (u.startsWith("SELECT SLOT FROM DEVICES")) {
			this.rowsRead += 1;
			const slot = this.devices.get(params[0] as string);
			return cursor(slot === undefined ? [] : [{ slot }]);
		}

		if (u.startsWith("DELETE FROM META")) {
			const m = /KEY = '([^']+)'/i.exec(q);
			if (m) this.meta.delete(m[1] as string);
			return cursor([]);
		}

		throw new Error(`FakeSql: unsupported query: ${query}`);
	};

	/** Writes rows the way a pre-fix deployment left them: no counter touch. */
	seedFile(path: string, content: string, deleted = 0): void {
		this.files.set(path, { content, deleted });
	}

	/** The ground-truth SUM(LENGTH(content)) over live rows. */
	liveBytes(): number {
		let total = 0;
		for (const f of this.files.values()) {
			if (f.deleted === 0) total += sqliteLength(f.content);
		}
		return total;
	}
}

/** Mirrors WorkspaceDurableObject.pushFile's server-side sequence per file. */
function pushOne(fake: FakeSql, path: string, content: string): void {
	const sql = fake.sql;
	assertCommentLogSlotInvariant(sql, path, "d");
	approximateWorkspaceBytes(sql); // the cap check
	upsertFile(sql, { path, contentHash: "h", content, deviceId: "d" });
}

describe("BUG-LW1: pushing N files reads O(N) rows, not O(N²)", () => {
	it("200 pushes cost linearly-bounded row reads with exactly one full scan", () => {
		const fake = new FakeSql();
		ensureSchema(fake.sql);

		const N = 200;
		for (let i = 0; i < N; i++) {
			// Every 7th note carries emoji: JS .length and SQLite LENGTH()
			// disagree here, so this also proves the counter matches SQLite.
			const content =
				i % 7 === 0 ? `note ${i} 📝🎉` : `note ${i} ${"x".repeat(40)}`;
			pushOne(fake, `note-${i}.md`, content);
		}

		// The smoking gun: the scan runs once (initial backfill on an empty
		// table), not once per push. Pre-fix this would be N.
		expect(fake.fullScans).toBe(1);
		// Linear bound: ~3 one-row reads per push (cap check + ensure + PK
		// lookup). Quadratic pre-fix cost would be N(N-1)/2 ≈ 20,000 rows.
		expect(fake.rowsRead).toBeLessThanOrEqual(N * 5);
		// And the counter is exactly right.
		expect(ensureBytesCounter(fake.sql)).toBe(fake.liveBytes());
		expect(approximateWorkspaceBytes(fake.sql)).toBe(fake.liveBytes());
	});

	it("updates, deletes, undeletes and double-deletes keep the counter exact", () => {
		const fake = new FakeSql();
		ensureSchema(fake.sql);
		const sql = fake.sql;

		pushOne(fake, "a.md", "hello"); // 5
		pushOne(fake, "b.md", "📝🎉"); // 2 code points, 4 UTF-16 units
		expect(approximateWorkspaceBytes(sql)).toBe(7);

		upsertFile(sql, {
			path: "a.md",
			contentHash: "h2",
			content: "hello world, edited",
			deviceId: "d",
		});
		expect(approximateWorkspaceBytes(sql)).toBe(fake.liveBytes());

		softDeleteFile(sql, { path: "a.md", deviceId: "d" });
		expect(approximateWorkspaceBytes(sql)).toBe(2);

		softDeleteFile(sql, { path: "a.md", deviceId: "d" }); // no-op
		expect(approximateWorkspaceBytes(sql)).toBe(2);

		softDeleteFile(sql, { path: "missing.md", deviceId: "d" }); // no-op
		expect(approximateWorkspaceBytes(sql)).toBe(2);

		// Undelete via re-push restores the bytes.
		upsertFile(sql, {
			path: "a.md",
			contentHash: "h3",
			content: "back",
			deviceId: "d",
		});
		expect(approximateWorkspaceBytes(sql)).toBe(2 + 4);
		expect(approximateWorkspaceBytes(sql)).toBe(fake.liveBytes());
	});
});

describe("BUG-LW1 migration: a DO with rows but no counter backfills once", () => {
	it("computes the correct total on first access and persists it", () => {
		const fake = new FakeSql();
		ensureSchema(fake.sql);
		// Simulate a pre-fix deployed DO: rows exist, counter key absent.
		fake.seedFile("old-1.md", "aaa");
		fake.seedFile("old-2.md", "b📝"); // 2 SQLite chars
		fake.seedFile("gone.md", "should not count", 1);
		fake.exec("DELETE FROM meta WHERE key = 'bytes'");

		expect(approximateWorkspaceBytes(fake.sql)).toBe(3 + 2);
		expect(fake.fullScans).toBe(1);

		// Persisted: a second call does no new scan and agrees.
		expect(approximateWorkspaceBytes(fake.sql)).toBe(5);
		expect(fake.fullScans).toBe(1);

		// Later pushes build on the backfilled base, still scan-free.
		pushOne(fake, "new.md", "zzzz");
		expect(approximateWorkspaceBytes(fake.sql)).toBe(5 + 4);
		expect(fake.fullScans).toBe(1);
	});

	it("an empty DO backfills to zero without error", () => {
		const fake = new FakeSql();
		ensureSchema(fake.sql);
		fake.exec("DELETE FROM meta WHERE key = 'bytes'");
		expect(approximateWorkspaceBytes(fake.sql)).toBe(0);
		expect(approximateWorkspaceBytes(fake.sql)).toBe(0);
		expect(fake.fullScans).toBe(1);
	});
});
