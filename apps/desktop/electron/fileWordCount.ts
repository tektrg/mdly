import fs from "node:fs/promises";

/**
 * Whole-file reads for the built-in Size / Word count fields. Only runs when a
 * view uses one of them (the property scan asks with `includeStats`), and then
 * only for files whose mtime moved, so the default scan stays head-only.
 */

/** Chunk size of the streaming count: memory per file stays bounded for a 40 MB note. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * A word = a run of non-whitespace bytes holding at least one letter, digit or
 * non-ASCII byte. So Markdown syntax alone (`#`, `-`, `---`, `|`) is not a
 * word and `don't` is one. Byte-level on UTF-8 (no decoding): fast, and
 * Latin/Vietnamese/Cyrillic text counts right; typographic punctuation
 * (U+2000-U+207F: dashes, curly quotes, ellipsis) is not content, so a lone
 * "—" is not a word. CJK text without spaces counts one word per run (known gap).
 */
export type WordCounter = {
	count: number;
	inRun: boolean;
	runHasContent: boolean;
	/** Continuation bytes left of a punctuation character (may span chunks). */
	punctuationBytesLeft: number;
};

export function createWordCounter(): WordCounter {
	return {
		count: 0,
		inRun: false,
		runHasContent: false,
		punctuationBytesLeft: 0,
	};
}

/** UTF-8 lead 0xE2 + 0x80/0x81 = U+2000-U+207F (General Punctuation). */
function startsGeneralPunctuation(bytes: Uint8Array, index: number): boolean {
	const next = bytes[index + 1];
	return bytes[index] === 0xe2 && (next === 0x80 || next === 0x81);
}

function isWhitespaceByte(byte: number): boolean {
	return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

function isContentByte(byte: number): boolean {
	return (
		byte >= 0x80 ||
		(byte >= 0x30 && byte <= 0x39) ||
		(byte >= 0x41 && byte <= 0x5a) ||
		(byte >= 0x61 && byte <= 0x7a)
	);
}

export function countWordBytes(counter: WordCounter, bytes: Uint8Array): void {
	let { count, inRun, runHasContent, punctuationBytesLeft } = counter;
	for (let index = 0; index < bytes.length; index++) {
		const byte = bytes[index] as number;
		if (punctuationBytesLeft > 0) {
			punctuationBytesLeft--;
			continue;
		}
		if (isWhitespaceByte(byte)) {
			if (inRun && runHasContent) count++;
			inRun = false;
			runHasContent = false;
			continue;
		}
		inRun = true;
		if (startsGeneralPunctuation(bytes, index)) {
			punctuationBytesLeft = 2;
		} else if (!runHasContent && isContentByte(byte)) {
			runHasContent = true;
		}
	}
	counter.count = count;
	counter.inRun = inRun;
	counter.runHasContent = runHasContent;
	counter.punctuationBytesLeft = punctuationBytesLeft;
}

export function finishWordCount(counter: WordCounter): number {
	return counter.count + (counter.inRun && counter.runHasContent ? 1 : 0);
}

export function countWords(text: string): number {
	const counter = createWordCounter();
	countWordBytes(counter, Buffer.from(text, "utf8"));
	return finishWordCount(counter);
}

export type FileHeadAndStats = {
	head: string;
	sizeBytes: number;
	/** Words in the whole file, front matter included (the caller subtracts it). */
	wordCount: number;
};

/** One streaming pass: the head for the property parser plus size and word count. Null = unreadable. */
export async function readFileHeadAndStats(
	path: string,
	headBytes: number,
): Promise<FileHeadAndStats | null> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(path, "r");
		const buffer = Buffer.allocUnsafe(Math.max(READ_CHUNK_BYTES, headBytes));
		const counter = createWordCounter();
		let head = "";
		let sizeBytes = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			if (sizeBytes === 0) {
				head = chunk.subarray(0, headBytes).toString("utf8");
			}
			sizeBytes += bytesRead;
			countWordBytes(counter, chunk);
		}
		return { head, sizeBytes, wordCount: finishWordCount(counter) };
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}
