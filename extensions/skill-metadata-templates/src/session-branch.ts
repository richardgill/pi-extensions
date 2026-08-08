import fs from "node:fs";

import {
  SessionManager,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export type ActiveRequest = {
  branchPoint: string | null;
  prompt: string;
};

const BRANCH_ERROR = "Session branching requires a persisted previous completed turn.";

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const messageText = (entry: SessionEntry): string | undefined => {
  if (entry.type !== "message" || entry.message.role !== "user") return;
  if (typeof entry.message.content === "string") return entry.message.content;
  return entry.message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
};

export const findActiveRequest = (sessionManager: ReadonlySessionManager): ActiveRequest => {
  const entry = [...sessionManager.getBranch()]
    .reverse()
    .find((candidate) => messageText(candidate) !== undefined);
  const prompt = entry ? messageText(entry) : undefined;
  if (!entry || !prompt?.trim()) {
    throw new Error("Skill delegation requires a textual active user request.");
  }
  return { branchPoint: entry.parentId, prompt };
};

const createEmptyChildSession = (
  sessionManager: ReadonlySessionManager,
  parentSession: string,
): string => {
  const child = SessionManager.create(sessionManager.getCwd(), sessionManager.getSessionDir(), {
    parentSession,
  });
  const childFile = child.getSessionFile();
  const header = child.getHeader();
  if (!childFile || !header) throw new Error("Failed to create the delegated child session.");
  fs.writeFileSync(childFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
  return childFile;
};

export const createPreviousTurnSession = (
  sessionManager: ReadonlySessionManager,
  branchPoint: string | null,
): string => {
  const sourceFile = sessionManager.getSessionFile();
  if (!sourceFile) throw new Error(BRANCH_ERROR);

  const path = branchPoint ? sessionManager.getBranch(branchPoint) : [];
  const conversation = path.filter((entry) => entry.type === "message");
  if (conversation.length === 0) return createEmptyChildSession(sessionManager, sourceFile);

  const hasCompletedTurn = conversation.some(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (!branchPoint || !hasCompletedTurn || !fs.existsSync(sourceFile)) {
    throw new Error(BRANCH_ERROR);
  }

  const helper = SessionManager.open(sourceFile, sessionManager.getSessionDir());
  const childFile = helper.createBranchedSession(branchPoint);
  if (!childFile) throw new Error("Failed to create the delegated child session branch.");
  return childFile;
};
