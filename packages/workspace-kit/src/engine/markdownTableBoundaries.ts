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

	const columnCount = cellCount(headerLine);
	const tableLines = [headerLine, delimiterLine];
	let endIndex = startIndex + 1;

	while (true) {
		const nextLine = lines[endIndex + 1];
		if (nextLine !== undefined && isTableRowLine(nextLine)) {
			endIndex += 1;
			tableLines.push(nextLine);
			continue;
		}

		// A single blank line followed by a row of matching shape is almost
		// always an accidental split of the same table (e.g. pasted content),
		// not an intentional new table — GFM would otherwise silently render
		// that row as a stray "|"-delimited paragraph. Skip the blank line so
		// it parses as one continuous table. A row immediately followed by
		// its own delimiter line is a real new table's header, not a
		// continuation, so that case is excluded.
		if (
			nextLine !== undefined &&
			nextLine.trim() === "" &&
			isContinuationRow(lines, endIndex + 2, columnCount)
		) {
			endIndex += 2;
			tableLines.push(lines[endIndex] ?? "");
			continue;
		}

		break;
	}

	return { lines: tableLines, endIndex };
}

function isContinuationRow(
	lines: string[],
	index: number,
	columnCount: number,
): boolean {
	const line = lines[index];
	if (line === undefined || !isTableRowLine(line)) return false;
	if (cellCount(line) !== columnCount) return false;
	if (isDelimiterLine(lines[index + 1] ?? "")) return false;
	return true;
}

function cellCount(line: string): number {
	return line.trim().split("|").slice(1, -1).length;
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
