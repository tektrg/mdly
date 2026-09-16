import { describe, expect, it } from "vitest";
import { resolveDocumentListingState } from "./documentListingState";

describe("resolveDocumentListingState", () => {
	it("reports a scan that has not finished", () => {
		expect(
			resolveDocumentListingState({ hasListedOnce: false, listingError: null }),
		).toEqual({ kind: "scanning" });
	});

	it("reports a failed scan even though refreshFiles left files empty", () => {
		expect(
			resolveDocumentListingState({
				hasListedOnce: true,
				listingError: "EACCES",
			}),
		).toEqual({ kind: "failed", message: "EACCES" });
	});

	it("prefers the failure over the in-flight state, so a first failed scan is never 'still looking'", () => {
		expect(
			resolveDocumentListingState({
				hasListedOnce: false,
				listingError: "EACCES",
			}),
		).toEqual({ kind: "failed", message: "EACCES" });
	});

	it("only calls a workspace genuinely listed once a scan succeeded", () => {
		expect(
			resolveDocumentListingState({ hasListedOnce: true, listingError: null }),
		).toEqual({ kind: "listed" });
	});
});
