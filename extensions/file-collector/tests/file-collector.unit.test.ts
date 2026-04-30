import { describe, expect, it } from "vitest";

import {
  createSessionSidecarPath,
  extractAssistantReferences,
  extractBashOutputReferences,
  extractReadToolRange,
  extractWriteToolRange,
  formatFileLineEventDisplay,
  getBashOutputCommand,
  resolveAbsolutePath,
  resolveOptions,
} from "../src/extension.js";

describe("resolveOptions", () => {
  it("uses the default command name", () => {
    expect(resolveOptions().commandName).toBe("file-collector");
  });

  it("allows command name override", () => {
    expect(resolveOptions({ commandName: "collect-files" }).commandName).toBe("collect-files");
  });

  it("allows system prompt append text", () => {
    expect(
      resolveOptions({ appendSystemPrompt: "Use ./file.ts:1 format" }).appendSystemPrompt,
    ).toBe("Use ./file.ts:1 format");
  });

  it("collects write and edit tool events by default", () => {
    expect(resolveOptions().collectWriteTool).toBe(true);
    expect(resolveOptions().collectEditTool).toBe(true);
  });
});

describe("extractAssistantReferences", () => {
  const testCases = [
    {
      name: "extracts colon and GitHub-style line citations",
      input: "See ./a.ts:12-18 and packages/b.ts#L3-L5",
      expected: [
        { path: "./a.ts", startLine: 12, endLine: 18 },
        { path: "packages/b.ts", startLine: 3, endLine: 5 },
      ],
    },
    {
      name: "extracts citations before sentence punctuation",
      input: "Citations: ./sample.ts:2-3, ./notes.md:1-2.",
      expected: [
        { path: "./sample.ts", startLine: 2, endLine: 3 },
        { path: "./notes.md", startLine: 1, endLine: 2 },
      ],
    },
    {
      name: "ignores non-path colon text",
      input: "At 12:30 we discussed port:3000",
      expected: [],
    },
  ];

  it.each(testCases)("$name", ({ input, expected }) => {
    expect(extractAssistantReferences(input)).toEqual(expected);
  });
});

describe("resolveOptions config", () => {
  it("allows flat collector and sidecar options", () => {
    expect(resolveOptions({ sidecarEnabled: false, collectBashOutput: false })).toMatchObject({
      sidecarEnabled: false,
      collectBashOutput: false,
    });
  });

  it("accepts declarative bash shim commands", () => {
    const command = {
      name: "head",
      capture: {
        paths: { from: "lastPositional" as const },
        range: { from: "headLineCount" as const, option: "-n" },
      },
    };

    expect(resolveOptions({ bashShimCommands: [command] }).bashShimCommands).toEqual([command]);
  });
});

describe("getBashOutputCommand", () => {
  it("uses matching shim records for compound commands", () => {
    expect(
      getBashOutputCommand(
        'pwd && rg -n --with-filename "needle" ./src/a.ts',
        [
          { command: "cat", path: "./src/a.ts" },
          { command: "rg", path: "./src/a.ts", matchedText: "needle" },
        ],
        { path: "./src/a.ts", startLine: 7, matchedText: "needle found" },
      ),
    ).toBe("rg");
  });

  it("falls back to grep-style commands inside compound raw commands", () => {
    expect(
      getBashOutputCommand('pwd && rg -n "needle" ./src/a.ts', [], {
        path: "./src/a.ts",
        startLine: 7,
      }),
    ).toBe("rg");
  });
});

describe("extractBashOutputReferences", () => {
  const testCases = [
    {
      name: "extracts grep-style output",
      input: "./src/a.ts:7:const x = 1\nnot a ref",
      expected: [{ path: "./src/a.ts", startLine: 7, endLine: 7, matchedText: "const x = 1" }],
    },
    {
      name: "extracts absolute grep-style output",
      input: "/tmp/project/src/a.ts:12:http://example.test",
      expected: [
        {
          path: "/tmp/project/src/a.ts",
          startLine: 12,
          endLine: 12,
          matchedText: "http://example.test",
        },
      ],
    },
    {
      name: "ignores file collector jsonl lines",
      input:
        '{"source":"bash_output","path":"./src/a.ts","absolutePath":"/tmp/project/src/a.ts","startLine":7,"timestamp":"2026-04-29T22:31:21.427Z"}',
      expected: [],
    },
    {
      name: "ignores rg output of pi session jsonl lines",
      input:
        '9:{"type":"custom","customType":"file-line-event","data":{"source":"bash_output","path":"./src/a.ts","timestamp":"2026-04-29T22:31:21.427Z"}}',
      expected: [],
    },
  ];

  it.each(testCases)("$name", ({ input, expected }) => {
    expect(extractBashOutputReferences(input)).toEqual(expected);
  });
});

describe("extractReadToolRange", () => {
  const testCases = [
    {
      name: "uses offset and limit when present",
      content: "a\nb\nc\n",
      offset: 10,
      limit: 3,
      expected: { startLine: 10, endLine: 12 },
    },
    {
      name: "counts full text content when no limit is present",
      content: "a\nb\nc\n",
      offset: undefined,
      limit: undefined,
      expected: { startLine: 1, endLine: 3 },
    },
    {
      name: "counts content from an offset when no limit is present",
      content: "b\nc\n",
      offset: 2,
      limit: undefined,
      expected: { startLine: 2, endLine: 3 },
    },
    {
      name: "uses explicit showing lines output",
      content: "Showing lines 20-40",
      offset: undefined,
      limit: undefined,
      expected: { startLine: 20, endLine: 40 },
    },
  ];

  it.each(testCases)("$name", ({ content, offset, limit, expected }) => {
    expect(extractReadToolRange(content, offset, limit)).toEqual(expected);
  });
});

describe("extractWriteToolRange", () => {
  const testCases = [
    {
      name: "counts written text lines",
      content: "one\ntwo\nthree\n",
      expected: { startLine: 1, endLine: 3 },
    },
    {
      name: "counts final line without trailing newline",
      content: "one\ntwo",
      expected: { startLine: 1, endLine: 2 },
    },
    {
      name: "handles empty writes",
      content: "",
      expected: { startLine: 1 },
    },
  ];

  it.each(testCases)("$name", ({ content, expected }) => {
    expect(extractWriteToolRange(content)).toEqual(expected);
  });
});

describe("formatFileLineEventDisplay", () => {
  const testCases = [
    {
      name: "formats read events",
      event: { source: "read_tool" as const, path: "./sample.ts", startLine: 1, endLine: 5 },
      expected: "read ./sample.ts:1-5",
    },
    {
      name: "formats write events",
      event: { source: "write_tool" as const, path: "./generated.txt", startLine: 1, endLine: 3 },
      expected: "write ./generated.txt:1-3",
    },
    {
      name: "formats bash command events",
      event: {
        source: "bash_command" as const,
        path: "./sample.ts",
        startLine: 2,
        endLine: 3,
        command: "sed",
        matchedText: "2,3p",
      },
      expected: 'bash sed ./sample.ts:2-3 — "2,3p"',
    },
    {
      name: "formats bash command match events",
      event: {
        source: "bash_command" as const,
        path: "./sample.ts",
        command: "rg",
        matchedText: "beta",
      },
      expected: 'bash rg ./sample.ts — "beta"',
    },
    {
      name: "formats bash output events",
      event: {
        source: "bash_output" as const,
        path: "./sample.ts",
        startLine: 2,
        endLine: 2,
        matchedText: "beta",
      },
      expected: 'bash output ./sample.ts:2 — "beta"',
    },
    {
      name: "formats assistant output events",
      event: { source: "assistant_output" as const, path: "./notes.md", startLine: 1, endLine: 2 },
      expected: "cited ./notes.md:1-2",
    },
  ];

  it.each(testCases)("$name", ({ event, expected }) => {
    expect(formatFileLineEventDisplay(event)).toBe(expected);
  });
});

describe("resolveAbsolutePath", () => {
  it("resolves relative paths against cwd", () => {
    expect(resolveAbsolutePath("./a.ts", "/tmp/project")).toBe("/tmp/project/a.ts");
  });
});

describe("createSessionSidecarPath", () => {
  it("names the sidecar after the session file", () => {
    expect(
      createSessionSidecarPath(
        "/sessions/2026-04-29T22-42-11-601Z_019ddb68.jsonl",
        "file-line-events.jsonl",
      ),
    ).toBe("/sessions/2026-04-29T22-42-11-601Z_019ddb68-file-line-events.jsonl");
  });
});
