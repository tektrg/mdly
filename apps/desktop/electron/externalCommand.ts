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