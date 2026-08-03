import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverProjectSkillDirectories,
  formatContextSection,
  getAncestorDirectories,
  loadProjectContextFiles,
  projectResources,
  resolveOptions,
} from "../src/index";

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-project-resources-"));
  tempDirs.push(directory);
  return directory;
};

const makeExtensionHarness = () => {
  const handlers = new Map<string, EventHandler>();
  const pi = {
    on: vi.fn((eventName: string, handler: EventHandler) => {
      handlers.set(eventName, handler);
    }),
  } as unknown as ExtensionAPI;
  projectResources()(pi);
  return { handlers, pi };
};

const makeContext = ({ cwd, trusted }: { cwd: string; trusted: boolean }) =>
  ({
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
  }) as unknown as ExtensionContext;

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
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

  it("allows context and skill configuration overrides", () => {
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

describe("getAncestorDirectories", () => {
  it("orders ancestors from the filesystem root down to cwd", () => {
    const cwd = path.join(makeTempDir(), "project", "src");
    mkdirSync(cwd, { recursive: true });

    const directories = getAncestorDirectories(cwd);

    expect(directories[0]).toBe(path.parse(cwd).root);
    expect(directories.at(-2)).toBe(path.dirname(cwd));
    expect(directories.at(-1)).toBe(cwd);
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

    const discovered = discoverProjectSkillDirectories(
      nested,
      resolveOptions({ skillDirectoryPaths: [skills, skills] }),
    );

    expect(discovered).toEqual([skills]);
  });
});

describe("formatContextSection", () => {
  it("formats loaded files with the configured system prompt section title", () => {
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
  it("registers context and resource event handlers", () => {
    const { handlers } = makeExtensionHarness();

    expect([...handlers.keys()]).toEqual([
      "session_start",
      "resources_discover",
      "before_agent_start",
    ]);
  });

  it("does not contribute project skill paths when the project is untrusted", async () => {
    const cwd = makeTempDir();
    mkdirSync(path.join(cwd, ".pi", "skills"), { recursive: true });
    const { handlers } = makeExtensionHarness();

    const result = await handlers.get("resources_discover")?.(
      { cwd, reason: "startup" } as never,
      makeContext({ cwd, trusted: false }),
    );

    expect(result).toEqual({ skillPaths: [] });
  });

  it("contributes discovered skill paths through resources_discover when trusted", async () => {
    const root = makeTempDir();
    const cwd = path.join(root, "project", "src");
    const skills = path.join(root, ".claude", "skills");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(skills, { recursive: true });
    const { handlers } = makeExtensionHarness();

    const result = await handlers.get("resources_discover")?.(
      { cwd, reason: "startup" } as never,
      makeContext({ cwd, trusted: true }),
    );

    expect(result).toEqual({ skillPaths: [skills] });
  });

  it("retains context loading from session start through system prompt assembly", async () => {
    const cwd = makeTempDir();
    writeFileSync(path.join(cwd, "AGENTS.local.md"), "fixture context", "utf8");
    const { handlers } = makeExtensionHarness();
    const context = makeContext({ cwd, trusted: true });

    await handlers.get("session_start")?.({ reason: "startup" } as never, context);
    const result = await handlers.get("before_agent_start")?.(
      { systemPrompt: "base prompt" } as never,
      context,
    );

    expect(result).toMatchObject({ systemPrompt: expect.stringContaining("fixture context") });
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("# Extra Context Files"),
    });
  });
});
