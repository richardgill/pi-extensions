import {
  CustomEditor,
  SessionManager,
  type ExtensionAPI,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_PROMPTS = 100;

type HistoryEditor = {
  addToHistory?: (text: string) => void;
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

export const collectPromptCandidates = (
  entries: SessionEntry[],
  session: Pick<SessionInfo, "modified">,
  sessionIndex: number,
): PromptCandidate[] =>
  entries.flatMap((entry, entryIndex) => {
    const text = extractUserPromptText(entry);
    if (!text) {
      return [];
    }

    return [
      {
        text,
        timestamp: getPromptTimestamp(entry, session.modified.getTime()),
        sessionIndex,
        entryIndex,
      },
    ];
  });

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

const openSessionCandidates = (session: SessionInfo, sessionIndex: number): PromptCandidate[] => {
  try {
    return collectPromptCandidates(
      SessionManager.open(session.path).getEntries(),
      session,
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
  const sessions = await SessionManager.list(cwd);
  const candidates = sessions.flatMap(openSessionCandidates);
  return selectRecentPromptTexts(candidates, maxPrompts);
};

export const seedEditorHistory = (editor: HistoryEditor, promptsNewestFirst: string[]): void => {
  if (!editor.addToHistory) {
    return;
  }

  [...promptsNewestFirst].reverse().forEach((prompt: string) => editor.addToHistory?.(prompt));
};

export const upHistory = () => {
  return (pi: ExtensionAPI): void => {
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      const prompts = await loadRecentPrompts(ctx.cwd).catch(() => []);
      if (prompts.length === 0) {
        return;
      }

      const previousEditorFactory = ctx.ui.getEditorComponent();
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const editor =
          previousEditorFactory?.(tui, theme, keybindings) ??
          new CustomEditor(tui, theme, keybindings);
        seedEditorHistory(editor, prompts);
        return editor;
      });
    });
  };
};
