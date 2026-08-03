import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverProjectSkillDirectories,
  formatContextSection,
  loadProjectContextFiles,
  projectResources,
  resolveOptions,
} from "../src/index";

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-project-resources-"));
  tempDirs.push(dir);
  return dir;
};

const makeExtensionHarness = () => {
  const handlers = new Map<string, EventHandler>();
  const pi = {
    on: vi.fn((eventName: string, handler: EventHandler) => {
      handlers.set(eventName, handler);
    }),
  } as unknown as ExtensionAPI;
  projectResources()(pi);
  return handlers;
};

const makeContext = ({ cwd, trusted }: { cwd: string; trusted: boolean }) =>
  ({
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
  }) as unknown as ExtensionContext;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveOptions", () => {
  it("uses project context files and skill directories by default", () => {
    expect(resolveOptions()).toEqual({
      contextFilenames: ["AGENTS.local.md", "CLAUDE.local.md"],
      contextSectionTitle: "Extra Context Files",
      skillDirectoryPaths: [".pi/skills", ".claude/skills"],
    });
  });

  it("allows project resource configuration overrides", () => {
    expect(
      resolveOptions({
        contextFilenames: ["PI.local.md"],
        contextSectionTitle: "Extra Rules",
        skillDirectoryPaths: [".agent/skills"],
      }),
    ).toEqual({
      contextFilenames: ["PI.local.md"],
      contextSectionTitle: "Extra Rules",
      skillDirectoryPaths: [".agent/skills"],
    });
  });
});

describe("loadProjectContextFiles", () => {
  it("loads configured files from ancestors in top-down order", () => {
    const root = makeTempDir();
    const project = path.join(root, "project");
    const nested = path.join(project, "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, "AGENTS.local.md"), "root rules", "utf8");
    writeFileSync(path.join(project, "CLAUDE.local.md"), "project rules", "utf8");

    const files = loadProjectContextFiles(nested, resolveOptions());

    expect(files.map((file) => path.relative(root, file.path))).toEqual([
      "AGENTS.local.md",
      "project/CLAUDE.local.md",
    ]);
    expect(files.map((file) => file.content)).toEqual(["root rules", "project rules"]);
  });

  it("ignores missing files", () => {
    expect(loadProjectContextFiles(makeTempDir(), resolveOptions())).toEqual([]);
  });
});

describe("discoverProjectSkillDirectories", () => {
  it("discovers ancestor directories in top-down order", () => {
    const root = makeTempDir();
    const project = path.join(root, "project");
    const nested = path.join(project, "src");
    const rootSkills = path.join(root, ".claude", "skills");
    const projectSkills = path.join(project, ".pi", "skills");
    mkdirSync(nested, { recursive: true });
    mkdirSync(rootSkills, { recursive: true });
    mkdirSync(projectSkills, { recursive: true });

    expect(discoverProjectSkillDirectories(nested, resolveOptions())).toEqual([
      rootSkills,
      projectSkills,
    ]);
  });

  it("ignores missing paths and files", () => {
    const root = makeTempDir();
    const nested = path.join(root, "project", "src");
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "skills"), "not a directory", "utf8");

    expect(discoverProjectSkillDirectories(nested, resolveOptions())).toEqual([]);
  });

  it("deduplicates resolved directory paths", () => {
    const root = makeTempDir();
    const nested = path.join(root, "project");
    const skills = path.join(root, "skills");
    mkdirSync(nested, { recursive: true });
    mkdirSync(skills, { recursive: true });

    expect(
      discoverProjectSkillDirectories(
        nested,
        resolveOptions({ skillDirectoryPaths: [skills, skills] }),
      ),
    ).toEqual([skills]);
  });
});

describe("formatContextSection", () => {
  it("formats loaded files as a system prompt section", () => {
    const section = formatContextSection(
      [{ path: "/tmp/AGENTS.local.md", content: "Use these rules." }],
      resolveOptions({ contextSectionTitle: "Extra Rules" }),
    );

    expect(section).toContain("# Extra Rules");
    expect(section).toContain("## /tmp/AGENTS.local.md");
    expect(section).toContain("Use these rules.");
  });

  it("returns an empty string when no files are loaded", () => {
    expect(formatContextSection([], resolveOptions())).toBe("");
  });
});

describe("projectResources", () => {
  it("does not contribute project skill paths when the project is untrusted", async () => {
    const cwd = makeTempDir();
    mkdirSync(path.join(cwd, ".pi", "skills"), { recursive: true });
    const handlers = makeExtensionHarness();

    const result = await handlers.get("resources_discover")?.(
      { cwd, reason: "startup" } as never,
      makeContext({ cwd, trusted: false }),
    );

    expect(result).toEqual({ skillPaths: [] });
  });

  it("contributes discovered project skill paths when the project is trusted", async () => {
    const root = makeTempDir();
    const cwd = path.join(root, "project", "src");
    const skills = path.join(root, ".claude", "skills");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(skills, { recursive: true });
    const handlers = makeExtensionHarness();

    const result = await handlers.get("resources_discover")?.(
      { cwd, reason: "startup" } as never,
      makeContext({ cwd, trusted: true }),
    );

    expect(result).toEqual({ skillPaths: [skills] });
  });
});
