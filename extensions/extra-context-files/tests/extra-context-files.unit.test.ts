import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatContextSection, loadExtraContextFiles, resolveOptions } from "../src/extension.js";

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-extra-context-files-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveOptions", () => {
  it("uses extra context filenames by default", () => {
    expect(resolveOptions().filenames).toEqual(["AGENTS.local.md", "CLAUDE.local.md"]);
  });

  it("allows configuration overrides", () => {
    expect(
      resolveOptions({ filenames: ["PI.local.md"], sectionTitle: "Extra Rules" }),
    ).toMatchObject({
      filenames: ["PI.local.md"],
      sectionTitle: "Extra Rules",
    });
  });
});

describe("loadExtraContextFiles", () => {
  it("loads configured files from ancestors in top-down order", () => {
    const root = makeTempDir();
    const project = path.join(root, "project");
    const nested = path.join(project, "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, "AGENTS.local.md"), "root rules", "utf8");
    writeFileSync(path.join(project, "CLAUDE.local.md"), "project rules", "utf8");

    const files = loadExtraContextFiles(nested, resolveOptions());

    expect(files.map((file) => path.relative(root, file.path))).toEqual([
      "AGENTS.local.md",
      "project/CLAUDE.local.md",
    ]);
    expect(files.map((file) => file.content)).toEqual(["root rules", "project rules"]);
  });

  it("ignores missing files", () => {
    const dir = makeTempDir();

    expect(loadExtraContextFiles(dir, resolveOptions())).toEqual([]);
  });
});

describe("formatContextSection", () => {
  it("formats loaded files as a system prompt section", () => {
    const section = formatContextSection(
      [{ path: "/tmp/AGENTS.local.md", content: "Use these rules." }],
      resolveOptions({ sectionTitle: "Extra Rules" }),
    );

    expect(section).toContain("# Extra Rules");
    expect(section).toContain("## /tmp/AGENTS.local.md");
    expect(section).toContain("Use these rules.");
  });

  it("returns an empty string when no files are loaded", () => {
    expect(formatContextSection([], resolveOptions())).toBe("");
  });
});
