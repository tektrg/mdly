import { describe, expect, it } from "vitest";
import { detectLanguage, languageChanged } from "./textLanguage";
import { buildToolPrompt } from "./writingTools";

const VI = "Hôm nay tôi đi hoc ở trương, troi rất đep.";

describe("detectLanguage", () => {
	it("recognises Vietnamese by its letters", () => {
		expect(detectLanguage(VI)).toEqual({ code: "vi", name: "Vietnamese" });
	});
	it("recognises other scripts", () => {
		expect(detectLanguage("Привет, как дела?")?.code).toBe("ru");
		expect(detectLanguage("今日は学校に行きました。")?.code).toBe("ja");
		expect(detectLanguage("我今天去学校。")?.code).toBe("zh");
		expect(detectLanguage("오늘 학교에 갔어요.")?.code).toBe("ko");
		expect(detectLanguage("วันนี้ฉันไปโรงเรียน")?.code).toBe("th");
	});
	it("treats plain ASCII prose as English", () => {
		expect(detectLanguage("Today I went to school.")?.code).toBe("en");
	});
	it("returns null for other Latin text it can't name", () => {
		expect(detectLanguage("Ich wünsche dir schöne Grüße")).toBeNull();
		expect(detectLanguage("1234 !!")).toBeNull();
	});
});

describe("languageChanged", () => {
	it("flags a Vietnamese input answered in English", () => {
		expect(
			languageChanged(VI, "Today I went to school, the weather is very nice."),
		).toBe(true);
	});
	it("accepts a Vietnamese answer", () => {
		expect(
			languageChanged(VI, "Hôm nay tôi đi học ở trường, trời rất đẹp."),
		).toBe(false);
	});
	it("ignores inputs it can't classify and Markdown-only answers", () => {
		expect(languageChanged("Grüße", "Greetings")).toBe(false);
		expect(languageChanged(VI, "| a | b |")).toBe(false);
	});
	it("flags an English input answered in another script", () => {
		expect(languageChanged("Hello there friend.", "Привет, друг.")).toBe(true);
	});
});

describe("buildToolPrompt language line", () => {
	it("tells the model to keep the detected language", () => {
		const prompt = buildToolPrompt("Fix it.", VI);
		expect(prompt).toContain("Reply in Vietnamese. Do not translate.");
		// After the user's (editable) prompt, so custom tools get it too.
		expect(prompt.indexOf("Fix it.")).toBeLessThan(
			prompt.indexOf("Reply in Vietnamese"),
		);
	});
	it("falls back to 'same language' when unknown", () => {
		expect(buildToolPrompt("Fix it.", "Grüße aus Köln")).toContain(
			"Reply in the same language as the text. Do not translate.",
		);
	});
});
