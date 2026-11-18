/**
 * Dependency-free language guess for the writing tools. Small on-device
 * models drift into English when the instruction is English, so every run
 * names the selection's language, and a reply in a different language is a
 * failed run. Only languages we can tell apart reliably by script/letters are
 * named; anything else returns null ("same language as the text").
 */
export interface DetectedLanguage {
	/** BCP-47 code, also passed to the helper's locale check. */
	code: string;
	name: string;
}

// Letters only Vietnamese uses among Latin languages (đ, ơ, ư, ă and the
// stacked tone marks such as ạ ả ấ ầ ẩ ẫ ậ ...).
const VIETNAMESE = /[đĐơƠưƯăĂẠ-ỹ]/g;

const SCRIPTS: readonly [RegExp, DetectedLanguage][] = [
	[/[぀-ヿ]/g, { code: "ja", name: "Japanese" }],
	[/[가-힯]/g, { code: "ko", name: "Korean" }],
	[/[一-鿿]/g, { code: "zh", name: "Chinese" }],
	[/[Ѐ-ӿ]/g, { code: "ru", name: "Russian" }],
	[/[฀-๿]/g, { code: "th", name: "Thai" }],
	[/[؀-ۿ]/g, { code: "ar", name: "Arabic" }],
	[/[֐-׿]/g, { code: "he", name: "Hebrew" }],
	[/[Ͱ-Ͽ]/g, { code: "el", name: "Greek" }],
];

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

export function detectLanguage(text: string): DetectedLanguage | null {
	const letters = count(text, /\p{L}/gu);
	if (letters < 3) return null;
	// Kana marks Japanese even when mixed with kanji.
	if (count(text, SCRIPTS[0][0]) > 0) return SCRIPTS[0][1];
	for (const [re, language] of SCRIPTS.slice(1))
		if (count(text, re) / letters > 0.3) return language;
	if (count(text, VIETNAMESE) > 0) return { code: "vi", name: "Vietnamese" };
	const latin = count(text, /[A-Za-z]/g);
	if (latin === letters) return { code: "en", name: "English" };
	return null;
}

/**
 * True when the reply is clearly in a different language than the input
 * (e.g. Vietnamese diacritics vanished). Unclassifiable input or a reply with
 * too few letters never counts as a change.
 */
export function languageChanged(input: string, output: string): boolean {
	const before = detectLanguage(input);
	if (!before) return false;
	if (count(output, /\p{L}/gu) < 3) return false;
	const after = detectLanguage(output);
	return after?.code !== before.code;
}

export function languageInstruction(text: string): string {
	const language = detectLanguage(text);
	return language
		? `Reply in ${language.name}. Do not translate.`
		: "Reply in the same language as the text. Do not translate.";
}
