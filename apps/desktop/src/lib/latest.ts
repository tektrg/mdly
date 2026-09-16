/**
 * Wraps an async function so only the latest invocation can apply its
 * result.  Earlier in-flight calls become "stale" and silently no-op.
 *
 * ```ts
 * const load = latest(async ({ isStale }, path: string) => {
 *   const content = await readFile(path);
 *   if (isStale()) return;
 *   applyContent(content);
 * });
 * load("/a.md"); // starts, then…
 * load("/b.md"); // …makes the first call stale
 * ```
 *
 * `cancel()` makes every in-flight call stale without starting a new one — for
 * when the user navigates away from whatever the pending call would apply to.
 */
export type LatestFn<Args extends unknown[]> = ((
	...args: Args
) => Promise<void>) & { cancel: () => void };

export function latest<Args extends unknown[]>(
	fn: (signal: { isStale: () => boolean }, ...args: Args) => Promise<void>,
): LatestFn<Args> {
	let token = 0;

	const run = async (...args: Args) => {
		const myToken = ++token;
		await fn({ isStale: () => myToken !== token }, ...args);
	};
	run.cancel = () => {
		token++;
	};
	return run;
}
