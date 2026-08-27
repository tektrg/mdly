import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ensureLoginShellPathMerged spawns the user's real shell, which is slow and
 * environment-dependent (nvm/rvm init can take seconds). Point SHELL at a
 * tiny fixture script instead, so these tests stay fast and deterministic.
 */
async function writeFixtureShell(body: string): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), "hubble-fixture-shell-"));
	const scriptPath = join(dir, "shell.sh");
	await fs.writeFile(scriptPath, `#!/bin/sh\n${body}\n`);
	await fs.chmod(scriptPath, 0o755);
	return scriptPath;
}

describe("ensureLoginShellPathMerged", () => {
	const originalPath = process.env.PATH;
	const originalShell = process.env.SHELL;

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		process.env.SHELL = originalShell;
	});

	it("merges login-shell PATH dirs after the current PATH, deduped", async () => {
		process.env.PATH = "/current/bin:/shared/bin";
		process.env.SHELL = await writeFixtureShell(
			'echo "__HUBBLE_PATH__/login/bin:/shared/bin__HUBBLE_PATH__"',
		);

		const { ensureLoginShellPathMerged } = await import("./externalCommand");
		await ensureLoginShellPathMerged();

		expect(process.env.PATH?.split(delimiter)).toEqual([
			"/current/bin",
			"/shared/bin",
			"/login/bin",
		]);
	});

	it("leaves PATH unchanged when the shell cannot be spawned", async () => {
		process.env.PATH = "/current/bin";
		process.env.SHELL = "/no/such/shell";

		const { ensureLoginShellPathMerged } = await import("./externalCommand");
		await ensureLoginShellPathMerged();

		expect(process.env.PATH).toBe("/current/bin");
	});

	it("leaves PATH unchanged when the shell never prints the markers", async () => {
		process.env.PATH = "/current/bin";
		process.env.SHELL = await writeFixtureShell("echo 'no markers here'");

		const { ensureLoginShellPathMerged } = await import("./externalCommand");
		await ensureLoginShellPathMerged();

		expect(process.env.PATH).toBe("/current/bin");
	});

	it("spawns the shell only once across repeated calls", async () => {
		process.env.PATH = "/current/bin";
		const countFile = join(
			await fs.mkdtemp(join(tmpdir(), "hubble-fixture-count-")),
			"count",
		);
		process.env.SHELL = await writeFixtureShell(
			`printf x >> "${countFile}"\necho "__HUBBLE_PATH__/login/bin__HUBBLE_PATH__"`,
		);

		const { ensureLoginShellPathMerged } = await import("./externalCommand");
		await Promise.all([
			ensureLoginShellPathMerged(),
			ensureLoginShellPathMerged(),
		]);
		await ensureLoginShellPathMerged();

		expect(await fs.readFile(countFile, "utf8")).toBe("x");
	});
});
