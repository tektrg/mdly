// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The detector and its disk bridge keep module-level rolling-window state keyed
// by label, so reset the module graph between tests for independent windows.
async function loadDetector() {
	vi.resetModules();
	return import("./editorStormDetector");
}

type FakeHandler = (payload: { transaction: unknown }) => void;

function makeFakeEditor() {
	const handlers = new Map<string, Set<FakeHandler>>();
	return {
		isFocused: false,
		on(event: string, fn: FakeHandler) {
			let set = handlers.get(event);
			if (!set) {
				set = new Set();
				handlers.set(event, set);
			}
			set.add(fn);
		},
		off(event: string, fn: FakeHandler) {
			handlers.get(event)?.delete(fn);
		},
		emit(event: string, payload: { transaction: unknown }) {
			for (const fn of handlers.get(event) ?? []) fn(payload);
		},
		handlerCount(event: string) {
			return handlers.get(event)?.size ?? 0;
		},
	};
}

// A transaction shaped like the empty-but-storming no-ops the crash produces:
// zero steps, no doc change, carrying a plugin meta that names the culprit.
function fakeTransaction() {
	return {
		steps: [],
		docChanged: false,
		selectionSet: true,
		meta: { fakeSelection$: true },
	};
}

const STORM_THRESHOLD = 100;

describe("editor transaction storm detector", () => {
	let reportStorm: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		reportStorm = vi.fn();
		(window as unknown as { hubbleDiagnostics?: unknown }).hubbleDiagnostics = {
			reportStorm,
		};
		// The detector's report cooldown compares against lastReportedAt=0, so a
		// storm is only reported once the clock is past REPORT_COOLDOWN_MS. In the
		// real app performance.now() is always large (it runs for minutes before a
		// storm); pin it here so the window/cooldown math is deterministic.
		vi.spyOn(performance, "now").mockReturnValue(10_000);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		(
			window as unknown as { hubbleDiagnostics?: unknown }
		).hubbleDiagnostics = undefined;
	});

	it("reports once past the threshold with the storming transaction's shape and a stack", async () => {
		const { observeEditorTransactionStorms } = await loadDetector();
		const editor = makeFakeEditor();
		observeEditorTransactionStorms(editor as never);

		const transaction = fakeTransaction();
		for (let i = 0; i < STORM_THRESHOLD; i++) {
			editor.emit("transaction", { transaction });
		}

		expect(reportStorm).toHaveBeenCalledTimes(1);
		const payload = reportStorm.mock.calls[0][0];
		expect(payload.label).toBe("editor.transaction");
		expect(typeof payload.stack).toBe("string");
		expect(payload.detail).toMatchObject({
			steps: 0,
			docChanged: false,
			metaKeys: ["fakeSelection$"],
			editorFocused: false,
		});
	});

	it("stays silent below the storm threshold", async () => {
		const { observeEditorTransactionStorms } = await loadDetector();
		const editor = makeFakeEditor();
		observeEditorTransactionStorms(editor as never);

		const transaction = fakeTransaction();
		for (let i = 0; i < STORM_THRESHOLD - 1; i++) {
			editor.emit("transaction", { transaction });
		}

		expect(reportStorm).not.toHaveBeenCalled();
	});

	it("unsubscribes on dispose so a later storm is not attributed to a stale editor", async () => {
		const { observeEditorTransactionStorms } = await loadDetector();
		const editor = makeFakeEditor();
		const dispose = observeEditorTransactionStorms(editor as never);
		expect(editor.handlerCount("transaction")).toBe(1);

		dispose();
		expect(editor.handlerCount("transaction")).toBe(0);

		const transaction = fakeTransaction();
		for (let i = 0; i < STORM_THRESHOLD; i++) {
			editor.emit("transaction", { transaction });
		}
		expect(reportStorm).not.toHaveBeenCalled();
	});
});
