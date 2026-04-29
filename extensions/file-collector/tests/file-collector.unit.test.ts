import { describe, expect, it } from "vitest";

import {
  extractAssistantReferences,
  extractBashOutputReferences,
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
});

describe("extractAssistantReferences", () => {
  it("extracts colon and GitHub-style line citations", () => {
    expect(extractAssistantReferences("See ./a.ts:12-18 and packages/b.ts#L3-L5")).toEqual([
      { path: "./a.ts", startLine: 12, endLine: 18 },
      { path: "packages/b.ts", startLine: 3, endLine: 5 },
    ]);
  });

  it("ignores non-path colon text", () => {
    expect(extractAssistantReferences("At 12:30 we discussed port:3000")).toEqual([]);
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

describe("extractBashOutputReferences", () => {
  it("extracts grep-style output", () => {
    expect(extractBashOutputReferences("./src/a.ts:7:const x = 1\nnot a ref")).toEqual([
      { path: "./src/a.ts", startLine: 7, endLine: 7, matchedText: "const x = 1" },
    ]);
  });
});

describe("resolveAbsolutePath", () => {
  it("resolves relative paths against cwd", () => {
    expect(resolveAbsolutePath("./a.ts", "/tmp/project")).toBe("/tmp/project/a.ts");
  });
});
