/**
 * Who is watching a document. Each `mdly watch` writes one small JSON file
 * and refreshes `heartbeatAt`; the app shows a "watching" badge for every live
 * one. A subscriber counts as live while its heartbeat is fresh AND (when it
 * runs on this machine, which `mdly watch` always does — over ssh it still
 * executes here) its pid is alive. Files survive a restart; dead ones are
 * filtered out and pruned.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { docKey, hookDir } from "./events.js";

export const HEARTBEAT_MS = 10_000;
export const STALE_AFTER_MS = 35_000;

export interface Subscriber {
	id: string;
	doc: string;
	/** Who: e.g. "Claude". */
	name: string;
	/** Where the agent sits, e.g. "Air" when reached over ssh. */
	machine: string;
	host: string;
	pid: number;
	startedAt: string;
	heartbeatAt: string;
}

function subscribersDir(workspaceRoot: string): string {
	return path.join(hookDir(workspaceRoot), "subscribers");
}

function subscriberPath(
	workspaceRoot: string,
	sub: Pick<Subscriber, "id" | "doc">,
) {
	return path.join(
		subscribersDir(workspaceRoot),
		`${docKey(sub.doc)}~${sub.id}.json`,
	);
}

/** Machine label: explicit, else the ssh client's address, else this host. */
export function defaultMachineLabel(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const client =
		env.SSH_CONNECTION?.split(" ")[0] ?? env.SSH_CLIENT?.split(" ")[0];
	return client ? `ssh ${client}` : os.hostname().replace(/\.local$/, "");
}

export async function registerSubscriber(
	workspaceRoot: string,
	init: { doc: string; name: string; machine: string },
	now: Date = new Date(),
): Promise<Subscriber> {
	const sub: Subscriber = {
		id: randomUUID().slice(0, 8),
		doc: init.doc,
		name: init.name,
		machine: init.machine,
		host: os.hostname(),
		pid: process.pid,
		startedAt: now.toISOString(),
		heartbeatAt: now.toISOString(),
	};
	await fs.mkdir(subscribersDir(workspaceRoot), { recursive: true });
	await fs.writeFile(subscriberPath(workspaceRoot, sub), JSON.stringify(sub));
	return sub;
}

export async function heartbeatSubscriber(
	workspaceRoot: string,
	sub: Subscriber,
	now: Date = new Date(),
): Promise<void> {
	sub.heartbeatAt = now.toISOString();
	await fs.writeFile(subscriberPath(workspaceRoot, sub), JSON.stringify(sub));
}

export async function unregisterSubscriber(
	workspaceRoot: string,
	sub: Subscriber,
): Promise<void> {
	await fs.rm(subscriberPath(workspaceRoot, sub), { force: true });
}

export function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function isSubscriberLive(
	sub: Subscriber,
	now: Date,
	isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): boolean {
	const age = now.getTime() - Date.parse(sub.heartbeatAt);
	if (!(age >= -STALE_AFTER_MS && age <= STALE_AFTER_MS)) return false;
	if (sub.host === os.hostname() && !isPidAlive(sub.pid)) return false;
	return true;
}

/** Live subscribers for `doc` (or every doc when omitted); dead files are pruned. */
export async function listLiveSubscribers(
	workspaceRoot: string,
	doc?: string,
	now: Date = new Date(),
	isPidAlive?: (pid: number) => boolean,
): Promise<Subscriber[]> {
	let names: string[];
	try {
		names = await fs.readdir(subscribersDir(workspaceRoot));
	} catch {
		return [];
	}
	const live: Subscriber[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(subscribersDir(workspaceRoot), name);
		let sub: Subscriber;
		try {
			sub = JSON.parse(await fs.readFile(file, "utf8")) as Subscriber;
		} catch {
			continue;
		}
		if (!isSubscriberLive(sub, now, isPidAlive)) {
			await fs.rm(file, { force: true });
			continue;
		}
		if (doc === undefined || sub.doc === doc) live.push(sub);
	}
	return live;
}
