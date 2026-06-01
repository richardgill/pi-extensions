import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  CustomEditor,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_PROMPTS = 30;

type HistoryEditor = {
  addToHistory?: (text: string) => void;
};

type SessionFile = {
  path: string;
  modifiedMs: number;
};

type PromptCandidate = {
  text: string;
  timestamp: number;
  sessionIndex: number;
  entryIndex: number;
};

const extractTextContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      const text = (part as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
};

const parseEntryTimestamp = (entry: SessionEntry): number | undefined => {
  const parsed = new Date(entry.timestamp).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
};

const getPromptTimestamp = (entry: SessionEntry, fallback: number): number => {
  if (entry.type !== "message") {
    return fallback;
  }

  const timestamp = entry.message.timestamp;
  return typeof timestamp === "number" ? timestamp : (parseEntryTimestamp(entry) ?? fallback);
};

export const extractUserPromptText = (entry: SessionEntry): string | undefined => {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return undefined;
  }

  const text = extractTextContent(entry.message.content).trim();
  return text || undefined;
};

const toPromptCandidate = (
  entry: SessionEntry,
  fallbackTimestamp: number,
  sessionIndex: number,
  entryIndex: number,
): PromptCandidate | undefined => {
  const text = extractUserPromptText(entry);

  return text
    ? {
        text,
        timestamp: getPromptTimestamp(entry, fallbackTimestamp),
        sessionIndex,
        entryIndex,
      }
    : undefined;
};

const comparePromptCandidates = (a: PromptCandidate, b: PromptCandidate): number =>
  b.timestamp - a.timestamp || a.sessionIndex - b.sessionIndex || b.entryIndex - a.entryIndex;

export const selectRecentPromptTexts = (
  candidates: PromptCandidate[],
  maxPrompts = DEFAULT_MAX_PROMPTS,
): string[] => {
  const seen = new Set<string>();
  const prompts: string[] = [];

  for (const candidate of [...candidates].sort(comparePromptCandidates)) {
    if (!seen.has(candidate.text) && prompts.length < maxPrompts) {
      seen.add(candidate.text);
      prompts.push(candidate.text);
    }
  }

  return prompts;
};

const yieldToTui = async (): Promise<void> =>
  new Promise((resolveYield) => setImmediate(resolveYield));

export const getSessionDir = (cwd: string): string => {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safePath);
};

const listSessionFiles = async (cwd: string): Promise<SessionFile[]> => {
  try {
    const dir = getSessionDir(cwd);
    const entries = await readdir(dir, { withFileTypes: true });
    const files: SessionFile[] = [];

    for (const [index, entry] of entries.entries()) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const path = join(dir, entry.name);
        const fileStat = await stat(path);
        files.push({ path, modifiedMs: fileStat.mtime.getTime() });
      }

      if (index % 50 === 0) {
        await yieldToTui();
      }
    }

    return files.sort((a, b) => b.modifiedMs - a.modifiedMs || b.path.localeCompare(a.path));
  } catch {
    return [];
  }
};

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const parsePromptCandidateLine = (
  line: string,
  file: SessionFile,
  sessionIndex: number,
  entryIndex: number,
): PromptCandidate | undefined => {
  const entry = line.trim() ? (parseJsonLine(line) as SessionEntry | undefined) : undefined;
  return entry ? toPromptCandidate(entry, file.modifiedMs, sessionIndex, entryIndex) : undefined;
};

const parseSessionPromptCandidates = async (
  content: string,
  file: SessionFile,
  sessionIndex: number,
): Promise<PromptCandidate[]> => {
  const lines = content.trim().split("\n");
  const header = lines[0] ? (parseJsonLine(lines[0]) as { type?: unknown } | undefined) : undefined;
  const candidates: PromptCandidate[] = [];

  if (header?.type !== "session") {
    return [];
  }

  for (const [lineIndex, line] of lines.slice(1).entries()) {
    const entryIndex = lineIndex + 1;
    const candidate = parsePromptCandidateLine(line, file, sessionIndex, entryIndex);

    if (candidate) {
      candidates.push(candidate);
    }

    if (entryIndex % 200 === 0) {
      await yieldToTui();
    }
  }

  return candidates;
};

const readSessionPromptCandidates = async (
  file: SessionFile,
  sessionIndex: number,
): Promise<PromptCandidate[]> => {
  try {
    return await parseSessionPromptCandidates(
      await readFile(file.path, "utf8"),
      file,
      sessionIndex,
    );
  } catch {
    return [];
  }
};

export const loadRecentPrompts = async (
  cwd: string,
  maxPrompts = DEFAULT_MAX_PROMPTS,
): Promise<string[]> => {
  const files = await listSessionFiles(cwd);
  const candidates: PromptCandidate[] = [];
  let prompts: string[] = [];

  for (const [sessionIndex, file] of files.entries()) {
    if (prompts.length < maxPrompts) {
      candidates.push(...(await readSessionPromptCandidates(file, sessionIndex)));
      prompts = selectRecentPromptTexts(candidates, maxPrompts);
      await yieldToTui();
    }
  }

  return prompts;
};

export const seedEditorHistory = (editor: HistoryEditor, promptsNewestFirst: string[]): void => {
  if (!editor.addToHistory) {
    return;
  }

  [...promptsNewestFirst].reverse().forEach((prompt: string) => editor.addToHistory?.(prompt));
};

const installPromptHistory = (ctx: ExtensionContext): ((promptsNewestFirst: string[]) => void) => {
  const previousEditorFactory = ctx.ui.getEditorComponent();
  const seededEditors = new WeakSet<object>();
  let activeEditor: HistoryEditor | undefined;
  let prompts: string[] = [];

  const seedIfNeeded = (editor: HistoryEditor | undefined): void => {
    if (!editor || prompts.length === 0 || seededEditors.has(editor)) {
      return;
    }

    seedEditorHistory(editor, prompts);
    seededEditors.add(editor);
  };

  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const editor =
      previousEditorFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    activeEditor = editor;
    seedIfNeeded(editor);
    return editor;
  });

  return (promptsNewestFirst: string[]) => {
    prompts = promptsNewestFirst;
    seedIfNeeded(activeEditor);
  };
};

export const upHistory = () => {
  return (pi: ExtensionAPI): void => {
    let loadVersion = 0;

    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      const currentLoadVersion = ++loadVersion;
      const applyPrompts = installPromptHistory(ctx);

      void loadRecentPrompts(ctx.cwd)
        .then((prompts) => {
          if (currentLoadVersion !== loadVersion || prompts.length === 0) {
            return;
          }

          applyPrompts(prompts);
        })
        .catch(() => undefined);
    });

    pi.on("session_shutdown", () => {
      loadVersion += 1;
    });
  };
};
