type FenceState = {
	marker: "`" | "~";
	length: number;
};

const FENCE_OPEN_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

export function normalizeMarkdownTableBoundaries(markdown: string): string {
	const lines = markdown.split("\n");
	const output: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const table = tableAt(lines, index);
		if (!table) {
			output.push(lines[index] ?? "");
			continue;
		}

		if (output.length > 0 && output[output.length - 1]?.trim() !== "") {
			output.push("");
		}
		output.push(...table.lines);

		const nextLine = lines[table.endIndex + 1];
		if (nextLine !== undefined && nextLine.trim() !== "") {
			output.push("");
		}
		index = table.endIndex;
	}

	return output.join("\n");
}

function tableAt(
	lines: string[],
	startIndex: number,
): { lines: string[]; endIndex: number } | null {
	if (isInsideFence(lines, startIndex)) return null;

	const headerLine = lines[startIndex] ?? "";
	const delimiterLine = lines[startIndex + 1] ?? "";
	if (!isTableRowLine(headerLine) || !isDelimiterLine(delimiterLine)) {
		return null;
	}

	const tableLines = [headerLine, delimiterLine];
	let endIndex = startIndex + 1;
	while (isTableRowLine(lines[endIndex + 1] ?? "")) {
		endIndex += 1;
		tableLines.push(lines[endIndex] ?? "");
	}

	return { lines: tableLines, endIndex };
}

function isInsideFence(lines: string[], targetIndex: number): boolean {
	let fence: FenceState | null = null;
	for (let index = 0; index <= targetIndex; index += 1) {
		const line = lines[index] ?? "";
		if (fence && closesFence(line, fence)) {
			fence = null;
			continue;
		}

		const fenceMatch = FENCE_OPEN_LINE.exec(line);
		if (!fence && fenceMatch) {
			const fenceMarker = fenceMatch[1] ?? "";
			fence = {
				marker: fenceMarker[0] === "~" ? "~" : "`",
				length: fenceMarker.length,
			};
		}
	}
	return Boolean(fence);
}

function closesFence(line: string, fence: FenceState): boolean {
	const escapedMarker = fence.marker === "`" ? "`" : "~";
	const pattern = new RegExp(
		`^[ \\t]{0,3}${escapedMarker}{${fence.length},}[ \\t]*$`,
	);
	return pattern.test(line);
}

function isTableRowLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|")
	);
}

function isDelimiterLine(line: string): boolean {
	const cells = line
		.trim()
		.split("|")
		.slice(1, -1)
		.map((cell) => cell.trim());
	return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}
