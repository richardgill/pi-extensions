#!/usr/bin/env -S node --import tsx
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { sendUserMessage } from "./protocol";

type CliInput = { sessionId: string; deliverAs: "steer" | "followUp"; message: string };

const usage = (): string => "Usage: pi-ipc-send <sessionId> [--after-turn|--follow-up] <message>\n";

const parseInput = (args: string[]): CliInput | undefined => {
  const [sessionId, ...rest] = args;
  if (!sessionId) return undefined;
  const followUp = rest.at(0) === "--follow-up";
  const afterTurn = rest.at(0) === "--after-turn";
  const message = rest
    .slice(followUp || afterTurn ? 1 : 0)
    .join(" ")
    .trim();
  return { sessionId, deliverAs: followUp ? "followUp" : "steer", message };
};

const readMessage = async (message: string): Promise<string> =>
  message || (process.stdin.isTTY ? "" : (await readFile("/dev/stdin", "utf8")).trim());

const main = async (): Promise<void> => {
  const input = parseInput(process.argv.slice(2));
  if (!input) throw new Error(usage());
  const message = await readMessage(input.message);
  if (!message) throw new Error(usage());
  const response = await sendUserMessage(input.sessionId, {
    requestId: randomUUID(),
    message,
    deliverAs: input.deliverAs,
  });
  if (!response?.ok) throw new Error(JSON.stringify(response ?? { error: "unavailable" }));
  process.stdout.write(`${JSON.stringify(response)}\n`);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
