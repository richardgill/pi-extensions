import { describe, expect, it } from "vitest";

import { mergeRanges, resolveEditorCommand, revealExtension } from "../src/extension.js";

describe("mergeRanges", () => {
	it("merges and sorts ranges", () => {
		expect(mergeRanges("1,3-5", "2,6")).toBe("1-6");
	});

	it("returns undefined when both inputs are empty", () => {
		expect(mergeRanges(undefined, undefined)).toBeUndefined();
		expect(mergeRanges("", "")).toBeUndefined();
	});
});

describe("resolveEditorCommand", () => {
	it("prefers VISUAL over EDITOR and splits args", () => {
		const env = { VISUAL: "code --wait", EDITOR: "nvim" } as NodeJS.ProcessEnv;
		expect(resolveEditorCommand(env)).toEqual(["code", "--wait"]);
	});

	it("handles quoted args", () => {
		const env = { EDITOR: "nvim -u 'my init.vim'" } as NodeJS.ProcessEnv;
		expect(resolveEditorCommand(env)).toEqual(["nvim", "-u", "my init.vim"]);
	});
});

describe("revealExtension extract tests", () => {
	it("does not throw for matching test cases", () => {
		expect(() =>
			revealExtension({
				extract: {
					runTests: true,
					testCases: [
						{
							text: "See ./a.ts:1 and <file name=\"b.ts\">",
							expected: [
								{ path: "b.ts" },
								{ path: "./a.ts", ranges: "1" },
							],
						},
					],
				},
			})
		).not.toThrow();
	});

	it("throws when expected results do not match", () => {
		expect(() =>
			revealExtension({
				extract: {
					runTests: true,
					testCases: [{ text: "README.md", expected: [] }],
				},
			})
		).toThrow();
	});
});
