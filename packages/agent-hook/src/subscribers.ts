/**
 * Who is watching what. Each `mdly watch` (or MCP subscriber) writes one small
 * JSON file naming its scope (one file, a workspace folder, or the docs open
 * in mdly) into one registry under the app's data folder, and refreshes
 * `heartbeatAt`; the app shows a "watching" badge on every doc a live
 * subscriber's scope covers. A subscriber counts as live while its heartbeat is fresh AND (when it
 * runs on this machine, which `mdly watch` always does — over ssh it still
 * executes here) its pid is alive. Files survive a restart; dead ones are
 * filtered out and pruned.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WatchScope } from "./scope.js";

export const HEARTBEAT_MS = 10_000;
export const STALE_AFTER_MS = 35_000;

export interface Subscriber {
	id: string;
	scope: WatchScope;
	/** Who: e.g. "Claude". */
	name: string;
	/** Where the agent sits, e.g. "Air" when reached over ssh. */
	machine: string;
	host: string;
	pid: number;
	startedAt: string;
	heartbeatAt: string;
}

/** The registry: `<app data>/agent-hook/subscribers/`. */
export function subscribersDir(appDataDir: string): string {
	return path.join(appDataDir, "agent-hook", "subscribers");
}

function subscriberPath(appDataDir: string, sub: Pick<Subscriber, "id">) {
	return path.join(subscribersDir(appDataDir), `${sub.id}.json`);
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
	appDataDir: string,
	init: { scope: WatchScope; name: string; machine: string },
	now: Date = new Date(),
): Promise<Subscriber> {
	const sub: Subscriber = {
		id: randomUUID().slice(0, 12),
		scope: init.scope,
		name: init.name,
		machine: init.machine,
		host: os.hostname(),
		pid: process.pid,
		startedAt: now.toISOString(),
		heartbeatAt: now.toISOString(),
	};
	await fs.mkdir(subscribersDir(appDataDir), { recursive: true });
	await fs.writeFile(subscriberPath(appDataDir, sub), JSON.stringify(sub));
	return sub;
}

/** Writes (or refreshes) a subscriber under a caller-chosen id: polling transports re-register each call. */
export async function upsertSubscriber(
	appDataDir: string,
	sub: Subscriber,
): Promise<void> {
	await fs.mkdir(subscribersDir(appDataDir), { recursive: true });
	await fs.writeFile(subscriberPath(appDataDir, sub), JSON.stringify(sub));
}

export async function heartbeatSubscriber(
	appDataDir: string,
	sub: Subscriber,
	now: Date = new Date(),
): Promise<void> {
	sub.heartbeatAt = now.toISOString();
	await fs.writeFile(subscriberPath(appDataDir, sub), JSON.stringify(sub));
}

export async function unregisterSubscriber(
	appDataDir: string,
	sub: Subscriber,
): Promise<void> {
	await fs.rm(subscriberPath(appDataDir, sub), { force: true });
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

/** Every live subscriber; dead or unreadable files are pruned. */
export async function listLiveSubscribers(
	appDataDir: string,
	now: Date = new Date(),
	isPidAlive?: (pid: number) => boolean,
): Promise<Subscriber[]> {
	const dir = subscribersDir(appDataDir);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const live: Subscriber[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		let sub: Subscriber;
		try {
			sub = JSON.parse(await fs.readFile(file, "utf8")) as Subscriber;
		} catch {
			continue;
		}
		if (!sub?.scope || !isSubscriberLive(sub, now, isPidAlive)) {
			await fs.rm(file, { force: true });
			continue;
		}
		live.push(sub);
	}
	return live;
}
