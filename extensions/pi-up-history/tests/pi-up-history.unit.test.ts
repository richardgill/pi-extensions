import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  collectPromptCandidates,
  extractUserPromptText,
  seedEditorHistory,
  selectRecentPromptTexts,
} from "../src/extension";

const userEntry = (content: unknown, timestamp: number, id = `user-${timestamp}`): SessionEntry =>
  ({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "user", content, timestamp },
  }) as SessionEntry;

const assistantEntry = (timestamp: number): SessionEntry =>
  ({
    type: "message",
    id: `assistant-${timestamp}`,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "assistant" }], timestamp },
  }) as SessionEntry;

const sessionInfo = (modified: number): Pick<SessionInfo, "modified"> => ({
  modified: new Date(modified),
});

describe("extractUserPromptText", () => {
  it("extracts string and text-block user prompts", () => {
    expect(extractUserPromptText(userEntry("  hello  ", 1))).toBe("hello");
    expect(
      extractUserPromptText(
        userEntry(
          [
            { type: "text", text: "first" },
            { type: "image", data: "ignored", mimeType: "image/png" },
            { type: "text", text: "second" },
          ],
          2,
        ),
      ),
    ).toBe("first\nsecond");
  });

  it("ignores assistants and empty user prompts", () => {
    expect(extractUserPromptText(assistantEntry(1))).toBeUndefined();
    expect(extractUserPromptText(userEntry("   ", 2))).toBeUndefined();
  });
});

describe("selectRecentPromptTexts", () => {
  it("returns unique prompts newest first across sessions", () => {
    const candidates = [
      ...collectPromptCandidates(
        [userEntry("older same session", 10), userEntry("newest", 30), userEntry("duplicate", 20)],
        sessionInfo(30),
        0,
      ),
      ...collectPromptCandidates(
        [userEntry("duplicate", 40), userEntry("other", 25)],
        sessionInfo(40),
        1,
      ),
    ];

    expect(selectRecentPromptTexts(candidates)).toEqual([
      "duplicate",
      "newest",
      "other",
      "older same session",
    ]);
  });

  it("respects the max prompt count", () => {
    const candidates = collectPromptCandidates(
      [userEntry("one", 1), userEntry("two", 2), userEntry("three", 3)],
      sessionInfo(3),
      0,
    );

    expect(selectRecentPromptTexts(candidates, 2)).toEqual(["three", "two"]);
  });
});

describe("seedEditorHistory", () => {
  it("adds newest-first prompts in native Up-arrow order", () => {
    const nativeHistory: string[] = [];
    const editor = {
      addToHistory: (text: string) => {
        nativeHistory.unshift(text.trim());
      },
    };

    seedEditorHistory(editor, ["newest", "middle", "oldest"]);

    expect(nativeHistory).toEqual(["newest", "middle", "oldest"]);
  });

  it("does nothing when an editor does not expose history", () => {
    expect(() => seedEditorHistory({}, ["newest"])).not.toThrow();
  });
});
