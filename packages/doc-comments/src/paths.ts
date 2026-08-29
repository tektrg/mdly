export function joinPath(...segments: string[]): string {
	const nonEmpty = segments.filter((segment) => segment.length > 0);
	const isAbsolute = nonEmpty[0]?.startsWith("/") ?? false;
	const parts = nonEmpty
		.map((segment) => segment.replace(/^\/+/, "").replace(/\/+$/, ""))
		.filter((segment) => segment.length > 0);
	return `${isAbsolute ? "/" : ""}${parts.join("/")}`;
}
