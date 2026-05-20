import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ScriptedStep =
  | ScriptedToolCallStep
  | ScriptedTextStep
  | ScriptedExpectLatestToolResultStep
  | ScriptedRecordLatestToolResultStep;

type ScriptedToolCallStep = {
  type: "toolCall";
  name: string;
  args: Record<string, unknown>;
  delayMs?: number;
};

type ScriptedTextStep = {
  type: "text";
  text: string;
};

type ExpectedToolResult = {
  contains?: string;
  equals?: string;
};

type ScriptedExpectLatestToolResultStep = {
  type: "expectLatestToolResult";
  toolName: string;
  expected: ExpectedToolResult;
  text: string;
};

type ScriptedRecordLatestToolResultStep = {
  type: "recordLatestToolResult";
  outputPath: string;
  text: string;
  toolName?: string;
};

type RecordLatestToolResultOptions = {
  toolName?: string;
  text?: string;
};

export const scriptedToolCall = (
  name: string,
  args: Record<string, unknown>,
  options: { delayMs?: number } = {},
): ScriptedStep => ({
  type: "toolCall",
  name,
  args,
  ...options,
});

export const scriptedText = (text: string): ScriptedStep => ({
  type: "text",
  text,
});

export const bash = (command: string, options: Record<string, unknown> = {}): ScriptedStep =>
  scriptedToolCall("bash", { timeout: 5, ...options, command });

export const reply = scriptedText;

export const expectLatestToolResult = (
  toolName: string,
  expected: ExpectedToolResult,
  text = "",
): ScriptedStep => ({
  type: "expectLatestToolResult",
  toolName,
  expected,
  text,
});

export const recordLatestToolResult = (
  outputPath: string,
  options: RecordLatestToolResultOptions = {},
): ScriptedStep => ({
  type: "recordLatestToolResult",
  outputPath,
  text: options.text ?? "",
  ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
});

export const writeScriptedProvider = (root: string, steps: ScriptedStep[]): string => {
  const filePath = path.join(root, "scripted-provider.ts");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, scriptedProviderSource(steps), "utf8");
  return filePath;
};

const scriptedProviderSource = (steps: ScriptedStep[]): string => `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@mariozechner/pi-ai";

const SCRIPTED_PROVIDER = "scripted";
const SCRIPTED_MODEL = "scripted";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const contentBlockText = (block) => block?.type === "text" ? block.text ?? "" : "";

const messageText = (message) => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(contentBlockText).join("");
};

const latestToolResultText = (context, toolName) => {
  const messages = [...(context.messages ?? [])].reverse();
  const message = messages.find(
    (candidate) => candidate.role === "toolResult" && (toolName === undefined || candidate.toolName === toolName),
  );
  return messageText(message);
};

const writeText = (filePath, text) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf8");
};

const failExpectedText = (message, expected, actual) => {
  throw new Error(message + "\\nExpected: " + JSON.stringify(expected) + "\\nActual: " + JSON.stringify(actual));
};

const assertExpectedText = (actual, expected) => {
  if (expected.equals !== undefined && actual !== expected.equals) {
    failExpectedText("Expected latest tool result to equal text", expected.equals, actual);
  }

  if (expected.contains !== undefined && !actual.includes(expected.contains)) {
    failExpectedText("Expected latest tool result to contain text", expected.contains, actual);
  }
};

export default function scriptedProvider(pi) {
  const registration = registerFauxProvider({
    provider: SCRIPTED_PROVIDER,
    models: [{ id: SCRIPTED_MODEL, name: "Scripted", reasoning: false }],
  });

  registration.setResponses([
${steps.map((step) => `    ${scriptedStepSource(step)},`).join("\n")}
  ]);

  pi.registerProvider(SCRIPTED_PROVIDER, {
    baseUrl: "http://localhost:0",
    apiKey: "test-key",
    api: registration.api,
    models: [
      {
        id: SCRIPTED_MODEL,
        name: "Scripted",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });

  pi.on("session_shutdown", () => {
    registration.unregister();
  });
}
`;

const scriptedStepSource = (step: ScriptedStep): string => {
  if (step.type === "toolCall") return scriptedToolCallSource(step);
  if (step.type === "expectLatestToolResult") return scriptedExpectLatestToolResultSource(step);
  if (step.type === "recordLatestToolResult") return scriptedRecordLatestToolResultSource(step);
  return `fauxAssistantMessage(${JSON.stringify(step.text)})`;
};

const scriptedToolCallSource = (step: ScriptedToolCallStep): string => {
  const response = `fauxAssistantMessage([fauxToolCall(${JSON.stringify(step.name)}, ${JSON.stringify(step.args)})], { stopReason: "toolUse" })`;
  if (step.delayMs === undefined) return response;
  return `async () => { await sleep(${JSON.stringify(step.delayMs)}); return ${response}; }`;
};

const scriptedExpectLatestToolResultSource = (step: ScriptedExpectLatestToolResultStep): string =>
  `(context) => { assertExpectedText(latestToolResultText(context, ${JSON.stringify(step.toolName)}), ${JSON.stringify(step.expected)}); return fauxAssistantMessage(${JSON.stringify(step.text)}); }`;

const scriptedRecordLatestToolResultSource = (step: ScriptedRecordLatestToolResultStep): string =>
  `(context) => { writeText(${JSON.stringify(step.outputPath)}, latestToolResultText(context, ${JSON.stringify(step.toolName)})); return fauxAssistantMessage(${JSON.stringify(step.text)}); }`;
