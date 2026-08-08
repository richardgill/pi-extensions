import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getAgentDir,
  isReadToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
  type InputEventResult,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import {
  applyInstructions,
  matchSkill,
  prepareRules,
  renderMatchedSkill,
  SkillMetadataTemplatesConfigSchema,
  type PreparedRule,
  type RenderedInstructions,
  type SkillMetadataTemplatesOptions,
  type SkillTemplateRuntime,
} from "./rules";
import { createPreviousTurnSession, findActiveRequest, shellQuote } from "./session-branch";

export { SkillMetadataTemplatesConfigSchema } from "./rules";
export type { SkillMetadataTemplatesOptions } from "./rules";

type SkillCommand = { name: string; args: string };
type LoadedSkill = { name: string; path: string };
type PreparedRead = { instructions: RenderedInstructions };
type InvocationState = {
  inputText?: string;
  runtimes: Map<string, SkillTemplateRuntime>;
};
type ExtensionOptions = { templateBaseDir?: string };

const parseSkillCommand = (text: string): SkillCommand | undefined => {
  if (!text.startsWith("/skill:")) return;
  const spaceIndex = text.indexOf(" ");
  return {
    name: spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex),
    args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim(),
  };
};

const findSkillPath = (pi: ExtensionAPI, name: string): string | undefined =>
  pi.getCommands().find((command) => command.source === "skill" && command.name === `skill:${name}`)
    ?.sourceInfo.path;

const formatSkillExpansion = (
  command: SkillCommand,
  skillPath: string,
  content: string,
): string => {
  const baseDir = path.dirname(skillPath);
  const skillBlock = `<skill name="${command.name}" location="${skillPath}">\nReferences are relative to ${baseDir}.\n\n${content}\n</skill>`;
  return command.args ? `${skillBlock}\n\n${command.args}` : skillBlock;
};

const createTemplateRuntime = (invocation: string, branchPath?: string): SkillTemplateRuntime => ({
  sessionBranch: branchPath ? { pathShell: shellQuote(branchPath) } : undefined,
  skillInvocation: { shell: shellQuote(invocation) },
});

const reportInputError = (ctx: ExtensionContext, error: unknown): InputEventResult => {
  const message = error instanceof Error ? error.message : String(error);
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  else process.stderr.write(`${message}\n`);
  return { action: "handled" };
};

const handleInput = (
  pi: ExtensionAPI,
  rules: PreparedRule[],
  state: InvocationState,
  event: InputEvent,
  ctx: ExtensionContext,
): InputEventResult | undefined => {
  if (ctx.isIdle() && !event.streamingBehavior) {
    state.inputText = event.text;
    state.runtimes.clear();
  }

  const command = parseSkillCommand(event.text);
  if (!command) return;

  const skillPath = findSkillPath(pi, command.name);
  if (!skillPath) return;

  const matched = matchSkill(fs.readFileSync(skillPath, "utf8"), rules);
  if (matched.matchingRules.length === 0) return;

  try {
    if (matched.sessionBranch && (!ctx.isIdle() || event.streamingBehavior)) {
      throw new Error("Session branching is only supported for idle skill invocations.");
    }
    const branchPath = matched.sessionBranch
      ? createPreviousTurnSession(ctx.sessionManager, ctx.sessionManager.getLeafId())
      : undefined;
    const runtime = createTemplateRuntime(event.text, branchPath);
    const rendered = renderMatchedSkill(matched, runtime);
    state.runtimes.set(command.name, runtime);
    return {
      action: "transform",
      text: formatSkillExpansion(
        command,
        skillPath,
        applyInstructions(rendered.body, rendered.instructions!),
      ),
    };
  } catch (error) {
    if (matched.sessionBranch) return reportInputError(ctx, error);
    throw error;
  }
};

const normalizePath = (cwd: string, filePath: string): string => {
  const withoutAt = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  const expandedPath = withoutAt.startsWith("~/")
    ? path.join(os.homedir(), withoutAt.slice(2))
    : withoutAt;
  return path.resolve(cwd, expandedPath);
};

const findLoadedSkill = (
  pi: ExtensionAPI,
  cwd: string,
  filePath: string,
): LoadedSkill | undefined => {
  const resolvedPath = normalizePath(cwd, filePath);
  const command = pi
    .getCommands()
    .find(
      (candidate) =>
        candidate.source === "skill" &&
        normalizePath(cwd, candidate.sourceInfo.path) === resolvedPath,
    );
  if (!command) return;
  return { name: command.name.slice(6), path: resolvedPath };
};

const handleToolCall = (
  pi: ExtensionAPI,
  rules: PreparedRule[],
  preparedReads: Map<string, PreparedRead>,
  state: InvocationState,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): ToolCallEventResult | undefined => {
  if (event.toolName !== "read" || typeof event.input.path !== "string") return;
  const skill = findLoadedSkill(pi, ctx.cwd, event.input.path);
  if (!skill) return;

  const matched = matchSkill(fs.readFileSync(skill.path, "utf8"), rules);
  if (matched.matchingRules.length === 0) return;

  try {
    let runtime = state.runtimes.get(skill.name);
    if (!runtime) {
      const activeRequest = findActiveRequest(ctx.sessionManager);
      const prompt = state.inputText ?? activeRequest.prompt;
      const invocation = `/skill:${skill.name} ${prompt}`;
      const branchPath = matched.sessionBranch
        ? createPreviousTurnSession(ctx.sessionManager, activeRequest.branchPoint)
        : undefined;
      runtime = createTemplateRuntime(invocation, branchPath);
    }

    const { instructions } = renderMatchedSkill(matched, runtime);
    state.runtimes.set(skill.name, runtime);
    preparedReads.set(event.toolCallId, { instructions: instructions! });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { block: true, reason };
  }
};

const handleToolResult = (preparedReads: Map<string, PreparedRead>, event: ToolResultEvent) => {
  const prepared = preparedReads.get(event.toolCallId);
  preparedReads.delete(event.toolCallId);
  if (!prepared || !isReadToolResult(event) || event.isError) return;

  return {
    content: event.content.map((content) =>
      content.type === "text"
        ? { ...content, text: applyInstructions(content.text, prepared.instructions) }
        : content,
    ),
  };
};

export const skillMetadataTemplates = (
  options: SkillMetadataTemplatesOptions = {},
  extensionOptions: ExtensionOptions = {},
) => {
  const templateBaseDir =
    extensionOptions.templateBaseDir ?? process.env.PI_EXTENSION_CONFIG_DIR ?? getAgentDir();
  const rules = prepareRules(options, templateBaseDir);

  return (pi: ExtensionAPI): void => {
    const preparedReads = new Map<string, PreparedRead>();
    const state: InvocationState = { runtimes: new Map() };
    pi.on("input", (event, ctx) => handleInput(pi, rules, state, event, ctx));
    pi.on("tool_call", (event, ctx) => handleToolCall(pi, rules, preparedReads, state, event, ctx));
    pi.on("tool_result", (event) => handleToolResult(preparedReads, event));
    pi.on("agent_settled", () => {
      state.inputText = undefined;
      state.runtimes.clear();
    });
  };
};
