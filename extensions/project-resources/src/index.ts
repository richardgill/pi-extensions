import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";

export type ProjectResourcesOptions = {
  contextFilenames?: string[];
  contextSectionTitle?: string;
  skillDirectoryPaths?: string[];
};

type ResolvedProjectResourcesOptions = Required<ProjectResourcesOptions>;

export type ProjectContextFile = {
  path: string;
  content: string;
};

export const DEFAULT_OPTIONS: ResolvedProjectResourcesOptions = {
  contextFilenames: ["AGENTS.local.md", "CLAUDE.local.md"],
  contextSectionTitle: "Extra Context Files",
  skillDirectoryPaths: [".pi/skills", ".claude/skills"],
};

const OptionsSchema = z.object({
  contextFilenames: z.array(z.string()).default(() => [...DEFAULT_OPTIONS.contextFilenames]),
  contextSectionTitle: z.string().default(DEFAULT_OPTIONS.contextSectionTitle),
  skillDirectoryPaths: z.array(z.string()).default(() => [...DEFAULT_OPTIONS.skillDirectoryPaths]),
});

const ConfigSchema = OptionsSchema;

const isPresent = <T>(value: T | null): value is T => value !== null;

export const resolveOptions = (
  input: ProjectResourcesOptions = {},
): ResolvedProjectResourcesOptions => OptionsSchema.parse(input);

const getAncestorDirs = (cwd: string): string[] => {
  const dir = path.resolve(cwd);
  const parent = path.dirname(dir);
  if (parent === dir) {
    return [dir];
  }
  return [...getAncestorDirs(parent), dir];
};

const getSkillAncestorDirs = (cwd: string): string[] => {
  const dirs = getAncestorDirs(cwd);
  const homeIndex = dirs.indexOf(path.resolve(os.homedir()));
  return homeIndex === -1 ? dirs : dirs.slice(homeIndex + 1);
};

const isDirectory = (directoryPath: string): boolean => {
  try {
    return statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
};

const loadContextFile = (filePath: string): ProjectContextFile | null => {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return null;
    }
    return { path: filePath, content: readFileSync(filePath, "utf8") };
  } catch {
    return null;
  }
};

export const loadProjectContextFiles = (
  cwd: string,
  options: Pick<ResolvedProjectResourcesOptions, "contextFilenames">,
): ProjectContextFile[] =>
  getAncestorDirs(cwd).flatMap((dir) =>
    options.contextFilenames
      .map((filename) => loadContextFile(path.join(dir, filename)))
      .filter(isPresent),
  );

export const discoverProjectSkillDirectories = (
  cwd: string,
  options: Pick<ResolvedProjectResourcesOptions, "skillDirectoryPaths">,
): string[] => [
  ...new Set(
    getSkillAncestorDirs(cwd)
      .flatMap((dir) =>
        options.skillDirectoryPaths.map((skillPath) => path.resolve(dir, skillPath)),
      )
      .filter(isDirectory),
  ),
];

export const formatContextSection = (
  files: ProjectContextFile[],
  options: Pick<ResolvedProjectResourcesOptions, "contextSectionTitle">,
): string => {
  if (files.length === 0) {
    return "";
  }

  const body = files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n");
  return `\n\n# ${options.contextSectionTitle}\n\nAdditional project instructions and guidelines:\n\n${body}\n`;
};

const formatDisplayPath = (filePath: string, cwd: string): string => {
  const relative = path.relative(cwd, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative;
};

const printStartupSection = (
  ctx: ExtensionContext,
  files: ProjectContextFile[],
  options: Pick<ResolvedProjectResourcesOptions, "contextSectionTitle">,
): void => {
  if (!ctx.hasUI || files.length === 0) {
    return;
  }

  const unindent = "\b";
  const header = `${unindent}${ctx.ui.theme.fg("mdHeading", `[${options.contextSectionTitle}]`)}`;
  const paths = files
    .map(
      (file) =>
        `${unindent}${ctx.ui.theme.fg("dim", `  ${formatDisplayPath(file.path, ctx.cwd)}`)}`,
    )
    .join("\n");
  ctx.ui.notify(`${header}\n${paths}`, "info");
};

export const projectResources = (input: ProjectResourcesOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    let loadedFiles: ProjectContextFile[] | undefined;

    pi.on("session_start", async (_event, ctx) => {
      loadedFiles = loadProjectContextFiles(ctx.cwd, options);
      printStartupSection(ctx, loadedFiles, options);
    });

    pi.on("resources_discover", async (event, ctx) => {
      const trustedContext = ctx as ExtensionContext & { isProjectTrusted(): boolean };
      if (!trustedContext.isProjectTrusted()) {
        return { skillPaths: [] };
      }
      return { skillPaths: discoverProjectSkillDirectories(event.cwd, options) };
    });

    pi.on("before_agent_start", async (event, ctx) => {
      loadedFiles = loadedFiles ?? loadProjectContextFiles(ctx.cwd, options);
      const section = formatContextSection(loadedFiles, options);
      if (!section) {
        return;
      }
      return { systemPrompt: `${event.systemPrompt}${section}` };
    });
  };
};

const config = loadConfigOrDefault({
  filename: "project-resources.jsonc",
  schema: ConfigSchema,
});

export default projectResources(config);
