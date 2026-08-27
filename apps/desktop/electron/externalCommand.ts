import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export type CommandResult = {
	stdout: string;
	stderr: string;
};

export type ResolveCommandPathOptions = {
	pathEnv?: string;
	configuredCommand?: string | null;
	isExecutable?: (filePath: string) => boolean;
};

export function resolveCommandPath({
	commandName,
	pathEnv = process.env.PATH,
	configuredCommand,
	commonDirs,
	isExecutable = isExecutableFile,
}: ResolveCommandPathOptions & {
	commandName: string;
	commonDirs: string[];
}): string | null {
	const configured = configuredCommand?.trim();
	if (configured) {
		if (configured.includes("/")) return configured;
		return (
			findExecutableCommand(configured, pathEnv, [], isExecutable) ?? configured
		);
	}

	return findExecutableCommand(
		commandName,
		pathEnv,
		commonDirs,
		isExecutable,
	);
}

export function commandPathEnv(
	commandPath: string,
	extraDirs: string[],
	pathEnv = process.env.PATH,
): string {
	const helperDirs = [
		...(commandPath.includes("/") ? [dirname(commandPath)] : []),
		...extraDirs,
	];
	return uniquePathDirs([
		...helperDirs,
		...(pathEnv?.split(delimiter).filter(Boolean) ?? []),
	]).join(delimiter);
}

export function findExecutableCommand(
	command: string,
	pathEnv: string | undefined,
	extraDirs: string[],
	isExecutable: (filePath: string) => boolean,
): string | null {
	const searchDirs = [
		...(pathEnv?.split(delimiter).filter(Boolean) ?? []),
		...extraDirs,
	];
	const seenDirs = new Set<string>();
	for (const dir of searchDirs) {
		if (seenDirs.has(dir)) continue;
		seenDirs.add(dir);
		const candidate = join(dir, command);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

export function uniquePathDirs(dirs: string[]): string[] {
	const seenDirs = new Set<string>();
	const uniqueDirs: string[] = [];
	for (const dir of dirs) {
		if (seenDirs.has(dir)) continue;
		seenDirs.add(dir);
		uniqueDirs.push(dir);
	}
	return uniqueDirs;
}

export function isExecutableFile(filePath: string): boolean {
	try {
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * GUI-launched apps (Dock/Finder) inherit macOS's bare default PATH, not the
 * directories a login shell adds via .zshrc/.bashrc (nvm, rvm, homebrew, etc.).
 * A tool installed only under one of those (e.g. `npm install -g` under nvm)
 * is invisible to the packaged app even though the terminal finds it fine.
 * Markers guard against shell startup banners (nvm/rvm noise) polluting stdout.
 */
function resolveLoginShellPath(
	shell = process.env.SHELL || "/bin/zsh",
	timeoutMs = 15_000,
): Promise<string | null> {
	return new Promise((resolve) => {
		const marker = "__HUBBLE_PATH__";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(shell, ["-ilc", `echo ${marker}$PATH${marker}`], {
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			resolve(null);
			return;
		}
		let stdout = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(null);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
		child.on("close", () => {
			clearTimeout(timeout);
			const match = new RegExp(`${marker}([\\s\\S]*?)${marker}`).exec(stdout);
			resolve(match ? match[1].trim() : null);
		});
	});
}

let mergedLoginShellPath: Promise<void> | null = null;

/**
 * Merges the login shell's PATH into process.env.PATH, once per app run.
 * Every command resolver here reads process.env.PATH lazily, so this single
 * merge fixes PATH visibility for anydoc, ntn-acct, and any future shell-out.
 */
export function ensureLoginShellPathMerged(): Promise<void> {
	if (!mergedLoginShellPath) {
		mergedLoginShellPath = resolveLoginShellPath().then((loginPath) => {
			if (!loginPath) return;
			const currentDirs = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
			const loginDirs = loginPath.split(delimiter).filter(Boolean);
			process.env.PATH = uniquePathDirs([...currentDirs, ...loginDirs]).join(
				delimiter,
			);
		});
	}
	return mergedLoginShellPath;
}

export function runCommand({
	commandPath,
	args,
	env,
	stdin,
	timeoutMs,
	commandLabel,
}: {
	commandPath: string;
	args: string[];
	env?: Record<string, string | undefined>;
	stdin?: string;
	timeoutMs: number;
	commandLabel: string;
}): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(commandPath, args, {
			env: { ...process.env, ...env },
			stdio:
				stdin === undefined
					? ["ignore", "pipe", "pipe"]
					: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`${commandLabel} command timed out.`));
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		if (stdin !== undefined) {
			child.stdin.end(stdin);
		}
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(
				new Error(
					stderr.trim() ||
						`${commandLabel} command failed with exit code ${code ?? "unknown"}.`,
				),
			);
		});
	});
}