import { describe, expect, it } from "vitest";
import { deviceLabelFor } from "./deviceLabel";

describe("deviceLabelFor", () => {
	it("labels the locked decision pairs", () => {
		expect(
			deviceLabelFor(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
			),
		).toBe("Safari - iPhone");
		expect(
			deviceLabelFor(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			),
		).toBe("Chrome - Mac");
	});

	it("covers iPad, Android, Firefox, and Edge", () => {
		expect(
			deviceLabelFor(
				"Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
			),
		).toBe("Safari - iPad");
		expect(
			deviceLabelFor(
				"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36",
			),
		).toBe("Chrome - Android");
		expect(
			deviceLabelFor(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
			),
		).toBe("Firefox - Mac");
		expect(
			deviceLabelFor(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
			),
		).toBe("Edge - Windows");
	});

	it("prefers the fork token over the embedded Safari/Chrome token", () => {
		// Chrome on iOS carries both CriOS and Safari tokens.
		expect(
			deviceLabelFor(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
			),
		).toBe("Chrome - iPhone");
	});

	it("falls back to Browser when half or all of the table misses", () => {
		expect(deviceLabelFor("")).toBe("Browser");
		expect(deviceLabelFor("curl/8.0")).toBe("Browser");
		expect(
			deviceLabelFor(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SomeBot/1.0",
			),
		).toBe("Browser");
		expect(deviceLabelFor("Chrome/120.0.0.0")).toBe("Browser");
	});
});
