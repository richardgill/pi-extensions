import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";

export type ExtraContextFilesOptions = {
  filenames?: string[];
  sectionTitle?: string;
  skillDirectoryPaths?: string[];
};

type ResolvedOptions = Required<ExtraContextFilesOptions>;

export type ExtraContextFile = {
  path: string;
  content: string;
};

export const DEFAULT_OPTIONS: ResolvedOptions = {
  filenames: ["AGENTS.local.md", "CLAUDE.local.md"],
  sectionTitle: "Extra Context Files",
  skillDirectoryPaths: [".pi/skills", ".claude/skills"],
};

const OptionsSchema = z.object({
  filenames: z.array(z.string()).default(() => [...DEFAULT_OPTIONS.filenames]),
  sectionTitle: z.string().default(DEFAULT_OPTIONS.sectionTitle),
  skillDirectoryPaths: z.array(z.string()).default(() => [...DEFAULT_OPTIONS.skillDirectoryPaths]),
});

const ConfigSchema = OptionsSchema;

const isPresent = <T>(value: T | null): value is T => value !== null;

export const resolveOptions = (input: ExtraContextFilesOptions = {}): ResolvedOptions =>
  OptionsSchema.parse(input);

const getAncestorDirs = (cwd: string): string[] => {
  const dir = path.resolve(cwd);
  const parent = path.dirname(dir);
  if (parent === dir) {
    return [dir];
  }
  return [...getAncestorDirs(parent), dir];
};

const isDirectory = (directoryPath: string): boolean => {
  try {
    return statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
};

const loadContextFile = (filePath: string): ExtraContextFile | null => {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return null;
    }
    return { path: filePath, content: readFileSync(filePath, "utf8") };
  } catch {
    return null;
  }
};

export const loadExtraContextFiles = (
  cwd: string,
  options: Pick<ResolvedOptions, "filenames">,
): ExtraContextFile[] =>
  getAncestorDirs(cwd).flatMap((dir) =>
    options.filenames
      .map((filename) => loadContextFile(path.join(dir, filename)))
      .filter(isPresent),
  );

export const discoverSkillDirectories = (
  cwd: string,
  options: Pick<ResolvedOptions, "skillDirectoryPaths">,
): string[] => [
  ...new Set(
    getAncestorDirs(cwd)
      .flatMap((dir) =>
        options.skillDirectoryPaths.map((skillPath) => path.resolve(dir, skillPath)),
      )
      .filter(isDirectory),
  ),
];

export const formatContextSection = (
  files: ExtraContextFile[],
  options: Pick<ResolvedOptions, "sectionTitle">,
): string => {
  if (files.length === 0) {
    return "";
  }

  const body = files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n");
  return `\n\n# ${options.sectionTitle}\n\nAdditional project instructions and guidelines:\n\n${body}\n`;
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
  files: ExtraContextFile[],
  options: Pick<ResolvedOptions, "sectionTitle">,
): void => {
  if (!ctx.hasUI || files.length === 0) {
    return;
  }

  const unindent = "\b";
  const header = `${unindent}${ctx.ui.theme.fg("mdHeading", `[${options.sectionTitle}]`)}`;
  const paths = files
    .map(
      (file) =>
        `${unindent}${ctx.ui.theme.fg("dim", `  ${formatDisplayPath(file.path, ctx.cwd)}`)}`,
    )
    .join("\n");
  ctx.ui.notify(`${header}\n${paths}`, "info");
};

export const extraContextFiles = (input: ExtraContextFilesOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    let loadedFiles: ExtraContextFile[] | undefined;

    pi.on("session_start", async (_event, ctx) => {
      loadedFiles = loadExtraContextFiles(ctx.cwd, options);
      printStartupSection(ctx, loadedFiles, options);
    });

    pi.on("resources_discover", async (event, ctx) => {
      const trustedContext = ctx as ExtensionContext & { isProjectTrusted(): boolean };
      if (!trustedContext.isProjectTrusted()) {
        return { skillPaths: [] };
      }
      return { skillPaths: discoverSkillDirectories(event.cwd, options) };
    });

    pi.on("before_agent_start", async (event, ctx) => {
      loadedFiles = loadedFiles ?? loadExtraContextFiles(ctx.cwd, options);
      const section = formatContextSection(loadedFiles, options);
      if (!section) {
        return;
      }
      return { systemPrompt: `${event.systemPrompt}${section}` };
    });
  };
};

const config = loadConfigOrDefault({
  filename: "extra-context-files.jsonc",
  schema: ConfigSchema,
});

export default extraContextFiles(config);
