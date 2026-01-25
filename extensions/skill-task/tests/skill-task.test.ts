import { describe, expect, it } from "vitest";

import { parseSkillCommand, parseSkillMetadata } from "../src/extension.js";

describe("parseSkillCommand", () => {
	it("parses skill name and prompt", () => {
		expect(parseSkillCommand("/skill:code-review Check this")).toEqual({
			name: "code-review",
			prompt: "Check this",
		});
	});

	it("handles leading whitespace", () => {
		expect(parseSkillCommand("  /skill:lint Fix issues")).toEqual({
			name: "lint",
			prompt: "Fix issues",
		});
	});

	it("returns null for non-skill input", () => {
		expect(parseSkillCommand("hello")).toBeNull();
	});
});

describe("parseSkillMetadata", () => {
	it("extracts pi metadata", () => {
		const content = `---
name: code-review
metadata:
  pi:
    forkContext: true
    model: openai-codex/gpt-5.2
    thinkingLevel: xhigh
---
body`;
		expect(parseSkillMetadata(content)).toEqual({
			forkContext: true,
			model: "openai-codex/gpt-5.2",
			thinkingLevel: "xhigh",
		});
	});

	it("defaults to forkContext false", () => {
		const content = "---\nname: code-review\n---\nbody";
		expect(parseSkillMetadata(content)).toEqual({ forkContext: false });
	});

	it("keeps model/thinking when forkContext missing", () => {
		const content = `---
name: code-review
metadata:
  pi:
    model: openai-codex/gpt-5.2
    thinkingLevel: xhigh
---
body`;
		expect(parseSkillMetadata(content)).toEqual({
			forkContext: false,
			model: "openai-codex/gpt-5.2",
			thinkingLevel: "xhigh",
		});
	});
});
