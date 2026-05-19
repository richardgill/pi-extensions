import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ScriptedStep = ScriptedToolCallStep | ScriptedTextStep | ScriptedContextTextStep;

type ScriptedToolCallStep = {
  type: "toolCall";
  name: string;
  args: Record<string, unknown>;
};

type ScriptedTextStep = {
  type: "text";
  text: string;
};

type ScriptedContextTextStep = {
  type: "contextText";
  contains: string;
  text: string;
  missingText?: string;
};

export const scriptedToolCall = (name: string, args: Record<string, unknown>): ScriptedStep => ({
  type: "toolCall",
  name,
  args,
});

export const scriptedText = (text: string): ScriptedStep => ({ type: "text", text });

export const bash = (command: string, options: Record<string, unknown> = {}): ScriptedStep =>
  scriptedToolCall("bash", { timeout: 5, ...options, command });

export const reply = scriptedText;

export const scriptedContextText = (contains: string, text = contains): ScriptedStep => ({
  type: "contextText",
  contains,
  text,
  missingText: `missing ${text}`,
});

export const replyIfContextContains = scriptedContextText;

export const writeScriptedProvider = (root: string, steps: ScriptedStep[]): string => {
  const filePath = path.join(root, "scripted-provider.ts");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, scriptedProviderSource(steps), "utf8");
  return filePath;
};

const scriptedProviderSource = (steps: ScriptedStep[]): string => `
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@mariozechner/pi-ai";

const SCRIPTED_PROVIDER = "scripted";
const SCRIPTED_MODEL = "scripted";

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
  if (step.type === "contextText") return scriptedContextTextSource(step);
  return `fauxAssistantMessage(${JSON.stringify(step.text)})`;
};

const scriptedToolCallSource = (step: ScriptedToolCallStep): string =>
  `fauxAssistantMessage([fauxToolCall(${JSON.stringify(step.name)}, ${JSON.stringify(step.args)})], { stopReason: "toolUse" })`;

const scriptedContextTextSource = (step: ScriptedContextTextStep): string =>
  `(context) => fauxAssistantMessage(JSON.stringify(context.messages).includes(${JSON.stringify(step.contains)}) ? ${JSON.stringify(step.text)} : ${JSON.stringify(step.missingText ?? `missing ${step.text}`)})`;
