import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  extractUserPromptText,
  getSessionDir,
  loadRecentPrompts,
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

const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const tmpDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-up-history-"));
  tmpDirs.push(dir);
  return dir;
};

const writeSession = async ({
  cwd,
  fileName,
  entries,
  modified,
}: {
  cwd: string;
  fileName: string;
  entries: SessionEntry[];
  modified: number;
}): Promise<void> => {
  const filePath = join(getSessionDir(cwd), fileName);
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: fileName,
      timestamp: new Date(modified).toISOString(),
      cwd,
    }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];

  await writeFile(filePath, `${lines.join("\n")}\n`);
  await utimes(filePath, new Date(modified), new Date(modified));
};

const withTempPiDir = async (run: (cwd: string) => Promise<void>): Promise<void> => {
  const piDir = await createTempDir();
  const cwd = await createTempDir();
  process.env.PI_CODING_AGENT_DIR = piDir;
  await mkdir(getSessionDir(cwd), { recursive: true });
  await run(cwd);
};

const prompts = (count: number, prefix: string, timestampStart: number): SessionEntry[] =>
  Array.from({ length: count }, (_, index) =>
    userEntry(`${prefix} ${index}`, timestampStart + index),
  );

afterEach(async () => {
  process.env.PI_CODING_AGENT_DIR = originalPiDir;

  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
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
    expect(
      selectRecentPromptTexts([
        { text: "older same session", timestamp: 10, sessionIndex: 0, entryIndex: 0 },
        { text: "newest", timestamp: 30, sessionIndex: 0, entryIndex: 1 },
        { text: "duplicate", timestamp: 20, sessionIndex: 0, entryIndex: 2 },
        { text: "duplicate", timestamp: 40, sessionIndex: 1, entryIndex: 0 },
        { text: "other", timestamp: 25, sessionIndex: 1, entryIndex: 1 },
      ]),
    ).toEqual(["duplicate", "newest", "other", "older same session"]);
  });

  it("respects the max prompt count", () => {
    expect(
      selectRecentPromptTexts(
        [
          { text: "one", timestamp: 1, sessionIndex: 0, entryIndex: 0 },
          { text: "two", timestamp: 2, sessionIndex: 0, entryIndex: 1 },
          { text: "three", timestamp: 3, sessionIndex: 0, entryIndex: 2 },
        ],
        2,
      ),
    ).toEqual(["three", "two"]);
  });
});

describe("loadRecentPrompts", () => {
  it("loads newest prompts first from local session files", async () => {
    await withTempPiDir(async (cwd) => {
      await writeSession({
        cwd,
        fileName: "older.jsonl",
        entries: [userEntry("older", 10)],
        modified: 10,
      });
      await writeSession({
        cwd,
        fileName: "newer.jsonl",
        entries: [userEntry("newer", 20)],
        modified: 20,
      });

      await expect(loadRecentPrompts(cwd)).resolves.toEqual(["newer", "older"]);
    });
  });

  it("stops at the default prompt limit", async () => {
    await withTempPiDir(async (cwd) => {
      await writeSession({
        cwd,
        fileName: "many.jsonl",
        entries: prompts(35, "prompt", 100),
        modified: 100,
      });

      const recentPrompts = await loadRecentPrompts(cwd);

      expect(recentPrompts).toHaveLength(30);
      expect(recentPrompts[0]).toBe("prompt 34");
      expect(recentPrompts[29]).toBe("prompt 5");
    });
  });

  it("skips malformed session files and malformed lines", async () => {
    await withTempPiDir(async (cwd) => {
      await writeFile(join(getSessionDir(cwd), "bad-header.jsonl"), "{}\n");
      await writeFile(
        join(getSessionDir(cwd), "mixed.jsonl"),
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "mixed",
            timestamp: "2026-01-01T00:00:00.000Z",
            cwd,
          }),
          "not-json",
          JSON.stringify(assistantEntry(1)),
          JSON.stringify(userEntry("valid", 2)),
        ].join("\n"),
      );

      await expect(loadRecentPrompts(cwd)).resolves.toEqual(["valid"]);
    });
  });
});

describe("getSessionDir", () => {
  it("uses Pi's configured agent dir and cwd encoding", async () => {
    const piDir = await createTempDir();
    process.env.PI_CODING_AGENT_DIR = piDir;

    expect(getSessionDir("/tmp/project:one")).toBe(join(piDir, "sessions", "--tmp-project-one--"));
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
