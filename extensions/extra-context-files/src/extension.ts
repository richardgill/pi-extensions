import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveOptions as resolveConfigOptions } from "@richardgill/pi-config";

export type ExtraContextFilesOptions = {
  filenames?: string[];
  sectionTitle?: string;
};

type ResolvedOptions = Required<ExtraContextFilesOptions>;

export type ExtraContextFile = {
  path: string;
  content: string;
};

export const DEFAULT_OPTIONS: ResolvedOptions = {
  filenames: ["AGENTS.local.md", "CLAUDE.local.md"],
  sectionTitle: "Extra Context Files",
};

const isPresent = <T>(value: T | null): value is T => value !== null;

export const resolveOptions = (input: ExtraContextFilesOptions = {}): ResolvedOptions =>
  resolveConfigOptions<ResolvedOptions>(DEFAULT_OPTIONS, input);

const getAncestorDirs = (cwd: string): string[] => {
  const dir = path.resolve(cwd);
  const parent = path.dirname(dir);
  if (parent === dir) {
    return [dir];
  }
  return [...getAncestorDirs(parent), dir];
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
