import { beforeEach, describe, expect, it } from "vitest";
import {
	createMainProcessErrorReporter,
	installMainProcessErrorHandlers,
	MAIN_PROCESS_ERROR_NOTICE_COOLDOWN_MS,
	type MainProcessErrorReporterDeps,
	mainProcessErrorKey,
} from "./mainProcessErrors";

function createDeps(
	overrides?: Partial<MainProcessErrorReporterDeps>,
): MainProcessErrorReporterDeps & {
	recorded: { event: string; data?: Record<string, unknown> }[];
	notified: { key: string; message: string }[];
} {
	const recorded: { event: string; data?: Record<string, unknown> }[] = [];
	const notified: { key: string; message: string }[] = [];
	return {
		recorded,
		notified,
		recordEvent: (event, data) => {
			recorded.push({ event, data });
		},
		notifyRenderer: (payload) => {
			notified.push(payload);
		},
		...overrides,
	};
}

describe("mainProcessErrorKey", () => {
	it("keys on name plus first message line", () => {
		const error = new Error("boom\nsecond line");
		error.name = "WebSocketError";
		expect(mainProcessErrorKey(error)).toBe("WebSocketError: boom");
	});

	it("keys non-errors without throwing", () => {
		expect(mainProcessErrorKey("plain string")).toBe("Unknown: plain string");
		expect(mainProcessErrorKey(undefined)).toBe("Unknown: undefined");
	});
});

describe("createMainProcessErrorReporter().report", () => {
	let now: number;
	let deps: ReturnType<typeof createDeps>;

	beforeEach(() => {
		now = 1_000_000;
		deps = createDeps({ now: () => now });
	});

	it("records to crash-trace and notifies the renderer, and does not throw or exit", () => {
		const { report } = createMainProcessErrorReporter(deps);
		const error = new Error("WebSocket was closed");
		expect(() => report(error)).not.toThrow();

		expect(deps.recorded).toHaveLength(1);
		expect(deps.recorded[0]?.event).toBe("main-process-error");
		expect(deps.recorded[0]?.data?.key).toBe("Error: WebSocket was closed");
		expect(deps.recorded[0]?.data?.stack).toContain("WebSocket was closed");

		expect(deps.notified).toHaveLength(1);
		expect(deps.notified[0]).toEqual({
			key: "Error: WebSocket was closed",
			message: "Error: WebSocket was closed",
		});
	});

	it("with no window present it still logs and does not throw (notify is a no-op)", () => {
		const windowless = createDeps({
			now: () => now,
			// Mirrors main.ts's sendToRenderer with no window: `mainWindow?.` — nothing to send to.
			notifyRenderer: () => {},
		});
		const { report } = createMainProcessErrorReporter(windowless);
		expect(() => report(new Error("early startup fault"))).not.toThrow();
		expect(windowless.recorded).toHaveLength(1);
		expect(windowless.recorded[0]?.event).toBe("main-process-error");
	});

	it("a throwing notify still cannot take down the reporter", () => {
		const { report } = createMainProcessErrorReporter(
			createDeps({
				now: () => now,
				notifyRenderer: () => {
					throw new Error("renderer gone");
				},
			}),
		);
		expect(() => report(new Error("fault during teardown"))).not.toThrow();
	});

	it("repeats inside the cooldown window are counted, not re-emitted", () => {
		const { report } = createMainProcessErrorReporter(deps);
		const error = () => new Error("timer fault");

		report(error());
		report(error());
		report(error());
		expect(deps.recorded).toHaveLength(1);
		expect(deps.notified).toHaveLength(1);

		// After the window, the next occurrence notifies again and carries
		// the suppressed count in the logged record.
		now += MAIN_PROCESS_ERROR_NOTICE_COOLDOWN_MS + 1;
		report(error());
		expect(deps.recorded).toHaveLength(2);
		expect(deps.notified).toHaveLength(2);
		expect(deps.recorded[1]?.data?.suppressedRepeats).toBe(2);
	});

	it("different errors are tracked independently", () => {
		const { report } = createMainProcessErrorReporter(deps);
		report(new Error("fault-a"));
		report(new Error("fault-b"));
		expect(deps.notified).toHaveLength(2);
	});
});

describe("installMainProcessErrorHandlers", () => {
	it("routes uncaughtException and unhandledRejection through report, and uninstalls cleanly", () => {
		const deps = createDeps();
		const beforeUncaught = process.listenerCount("uncaughtException");
		const beforeUnhandled = process.listenerCount("unhandledRejection");

		const uninstall = installMainProcessErrorHandlers(deps);
		expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught + 1);
		expect(process.listenerCount("unhandledRejection")).toBe(
			beforeUnhandled + 1,
		);

		// Drive the installed listeners directly (emitting real process
		// events would risk the runner's own handlers).
		const uncaughtListeners = process.listeners("uncaughtException");
		const unhandledListeners = process.listeners("unhandledRejection");
		const uncaught = uncaughtListeners[uncaughtListeners.length - 1] as (
			error: Error,
		) => void;
		const unhandled = unhandledListeners[unhandledListeners.length - 1] as (
			reason: unknown,
		) => void;
		expect(uncaught).toBeDefined();
		expect(unhandled).toBeDefined();
		uncaught(new Error("wired fault"));
		unhandled("wired rejection");
		expect(deps.recorded).toHaveLength(2);
		expect(deps.notified).toHaveLength(2);

		uninstall();
		expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
		expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
	});
});
