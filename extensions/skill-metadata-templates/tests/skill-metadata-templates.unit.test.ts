import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
  type InputEventResult,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfigOrDefault } from "@richardgill/pi-config";
import { afterEach, describe, expect, it, test as testCases } from "vitest";

import {
  skillMetadataTemplates,
  SkillMetadataTemplatesConfigSchema,
  type SkillMetadataTemplatesOptions,
} from "../src/extension";
import {
  applyInstructions,
  prepareRules,
  renderSkill,
  resolveTemplateFilePath,
} from "../src/rules";
import { shellQuote } from "../src/session-branch";

const tempDirs: string[] = [];
const createTempDir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "skill-metadata-templates-"));
  tempDirs.push(directory);
  return directory;
};

const skill = (metadata: string, body = "# Review\n\nReview the changes."): string => `---
name: code-review
description: Review code changes.
metadata:
${metadata}
---
${body}`;

afterEach(() => {
  tempDirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
});

describe("renderSkill", () => {
  it("renders every matching rule in declaration order", () => {
    const rules = prepareRules(
      {
        rules: [
          {
            name: "sub-process",
            when: { metadata: { "pi.subProcess": true } },
            template: "Use {{metadata.pi.subProcessContext}} context.",
          },
          {
            name: "tmux",
            when: { metadata: { "execution.tmux": true } },
            template: "Use tmux.",
          },
          {
            name: "named-window",
            when: { metadata: { "execution.tmux": true, "execution.namedWindow": true } },
            template:
              "Name it {{metadata.execution.windowName}} (attempt {{metadata.execution.attempt}}).",
          },
        ],
      },
      "/config",
    );
    const content = skill(`  pi:
    subProcess: true
    subProcessContext: fresh
  execution:
    tmux: true
    namedWindow: true
    windowName: review
    attempt: 2`);

    expect(renderSkill(content, rules).instructions).toEqual({
      top: [],
      bottom: ["Use fresh context.", "Use tmux.", "Name it review (attempt 2)."],
      replace: [],
    });
  });

  it("renders standard, metadata, and arbitrary frontmatter paths", () => {
    const rules = prepareRules(
      {
        rules: [
          {
            name: "frontmatter",
            when: { metadata: { enabled: true } },
            template:
              "{{name}} | {{description}} | {{license}} | {{metadata.execution.windowName}} | {{routing.owner.name}}",
          },
        ],
      },
      "/config",
    );
    const content = `---
name: code-review
description: Review code changes.
license: MIT
routing:
  owner:
    name: platform
metadata:
  enabled: true
  execution:
    windowName: review
---
# Review`;

    expect(renderSkill(content, rules).instructions).toEqual({
      top: [],
      bottom: ["code-review | Review code changes. | MIT | review | platform"],
      replace: [],
    });
  });

  it("requires every when entry and strict scalar equality", () => {
    const rules = prepareRules(
      {
        rules: [
          {
            name: "all-of",
            when: { metadata: { "execution.tmux": true, "execution.namedWindow": true } },
            template: "matched",
          },
          {
            name: "wrong-type",
            when: { metadata: { "execution.retries": "2" } },
            template: "wrong",
          },
          {
            name: "missing",
            when: { metadata: { "execution.missing": null } },
            template: "missing",
          },
        ],
      },
      "/config",
    );

    expect(
      renderSkill(
        skill(`  execution:
    tmux: true
    namedWindow: false
    retries: 2`),
        rules,
      ).instructions,
    ).toBeUndefined();
  });

  it("matches environment values and supports null for an unset variable", () => {
    const rules = prepareRules(
      {
        rules: [
          {
            name: "parent",
            when: {
              metadata: { enabled: true },
              environment: { PI_DELEGATE: null },
            },
            position: "replace",
            template: "Delegate this skill",
          },
          {
            name: "delegate",
            when: {
              metadata: { enabled: true },
              environment: { PI_DELEGATE: "1" },
            },
            template: "Run inside the delegate",
          },
        ],
      },
      "/config",
    );
    const content = skill("  enabled: true");

    expect(renderSkill(content, rules, {}).instructions).toEqual({
      top: [],
      bottom: [],
      replace: ["Delegate this skill"],
    });
    expect(renderSkill(content, rules, { PI_DELEGATE: "1" }).instructions).toEqual({
      top: [],
      bottom: ["Run inside the delegate"],
      replace: [],
    });
  });

  it("applies top, bottom, and replace rules while preserving group order", () => {
    const rules = prepareRules(
      {
        rules: [
          {
            name: "top-one",
            when: { metadata: { enabled: true } },
            position: "top",
            template: "Top one",
          },
          {
            name: "replacement-one",
            when: { metadata: { enabled: true } },
            position: "replace",
            template: "Replacement one",
          },
          { name: "bottom", when: { metadata: { enabled: true } }, template: "Bottom" },
          {
            name: "top-two",
            when: { metadata: { enabled: true } },
            position: "top",
            template: "Top two",
          },
          {
            name: "replacement-two",
            when: { metadata: { enabled: true } },
            position: "replace",
            template: "Replacement two",
          },
        ],
      },
      "/config",
    );
    const rendered = renderSkill(skill("  enabled: true"), rules);

    expect(applyInstructions(rendered.body, rendered.instructions!)).toBe(
      "Top one\n\nTop two\n\nReplacement one\n\nReplacement two\n\nBottom",
    );
  });

  it("throws a clear error for a missing placeholder value", () => {
    const rules = prepareRules(
      {
        rules: [
          {
            name: "window",
            when: { metadata: { "execution.tmux": true } },
            template: "Name it {{metadata.execution.windowName}}.",
          },
        ],
      },
      "/config",
    );

    expect(() => renderSkill(skill("  execution:\n    tmux: true"), rules)).toThrow(
      'Rule "window" uses missing frontmatter value "metadata.execution.windowName"',
    );
  });

  it("throws a clear error when a placeholder resolves to a non-scalar", () => {
    const rules = prepareRules(
      {
        rules: [
          {
            name: "window",
            when: { metadata: { "execution.tmux": true } },
            template: "Window: {{metadata.execution}}",
          },
        ],
      },
      "/config",
    );

    expect(() =>
      renderSkill(skill("  execution:\n    tmux: true\n    windowName: review"), rules),
    ).toThrow('Rule "window" placeholder "metadata.execution" is not a scalar value');
  });
});

describe("configuration", () => {
  it("accepts only the previous-turn session branch mode", () => {
    expect(
      prepareRules(
        {
          rules: [
            {
              name: "delegate",
              when: {},
              sessionBranch: "previousTurn",
              template: "Delegate",
            },
          ],
        },
        "/config",
      )[0]?.sessionBranch,
    ).toBe("previousTurn");
    expect(() =>
      SkillMetadataTemplatesConfigSchema.parse({
        rules: [{ name: "delegate", when: {}, sessionBranch: "current", template: "Delegate" }],
      }),
    ).toThrow();
  });

  it("requires exactly one inline or file template", () => {
    expect(() => prepareRules({ rules: [{ name: "missing", when: {} }] }, "/config")).toThrow(
      "exactly one of template or templateFile is required",
    );
    expect(() =>
      prepareRules(
        {
          rules: [{ name: "both", when: {}, template: "inline", templateFile: "template.md" }],
        },
        "/config",
      ),
    ).toThrow("exactly one of template or templateFile is required");
  });

  it("loads relative template files from the config directory", () => {
    const configDir = createTempDir();
    fs.mkdirSync(path.join(configDir, "templates"));
    fs.writeFileSync(
      path.join(configDir, "templates/tmux.md"),
      "Use {{metadata.execution.window}}.",
    );

    const rules = prepareRules(
      {
        rules: [
          {
            name: "tmux",
            when: { metadata: { "execution.tmux": true } },
            templateFile: "templates/tmux.md",
          },
        ],
      },
      configDir,
    );

    expect(
      renderSkill(skill("  execution:\n    tmux: true\n    window: review"), rules).instructions,
    ).toEqual({ top: [], bottom: ["Use review."], replace: [] });
  });

  it("expands home paths", () => {
    expect(resolveTemplateFilePath("~/templates/tmux.md", "/config")).toBe(
      path.join(os.homedir(), "templates/tmux.md"),
    );
  });

  it("reports malformed JSONC with its config path", () => {
    const configDir = createTempDir();
    fs.writeFileSync(path.join(configDir, "skill-metadata-templates.jsonc"), '{ "rules": [ }');

    expect(() =>
      loadConfigOrDefault({
        folder: configDir,
        filename: "skill-metadata-templates.jsonc",
        schema: SkillMetadataTemplatesConfigSchema,
      }),
    ).toThrow(`Invalid JSONC in ${path.join(configDir, "skill-metadata-templates.jsonc")}`);
  });
});

type InputHandler = (
  event: InputEvent,
  ctx: ExtensionContext,
) => InputEventResult | undefined | Promise<InputEventResult | undefined>;
type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;
type ToolResultPatch = { content: ToolResultEvent["content"] };
type ToolResultHandler = (
  event: ToolResultEvent,
  ctx: ExtensionContext,
) => ToolResultPatch | undefined | Promise<ToolResultPatch | undefined>;

type ConfigRule = NonNullable<SkillMetadataTemplatesOptions["rules"]>[number];

const defaultRules: ConfigRule[] = [
  {
    name: "tmux",
    when: { metadata: { "execution.tmux": true } },
    template: "Use tmux window {{metadata.execution.windowName}}.",
  },
];

const setupExtension = (skillPath: string, rules: ConfigRule[] = defaultRules) => {
  let inputHandler: InputHandler | undefined;
  let toolCallHandler: ToolCallHandler | undefined;
  let toolResultHandler: ToolResultHandler | undefined;
  const command = {
    name: "skill:code-review",
    source: "skill" as const,
    sourceInfo: { path: skillPath },
  };
  const pi = {
    getCommands: () => [command],
    on: (event: string, handler: InputHandler | ToolCallHandler | ToolResultHandler) => {
      if (event === "input") inputHandler = handler as InputHandler;
      if (event === "tool_call") toolCallHandler = handler as ToolCallHandler;
      if (event === "tool_result") toolResultHandler = handler as ToolResultHandler;
    },
  } as unknown as ExtensionAPI;

  skillMetadataTemplates({ rules })(pi);

  return {
    inputHandler: inputHandler!,
    toolCallHandler: toolCallHandler!,
    toolResultHandler: toolResultHandler!,
  };
};

type AssistantContent = Array<
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
>;

const appendAssistant = (
  sessionManager: SessionManager,
  content: AssistantContent,
  stopReason: "stop" | "toolUse" = "stop",
): string =>
  sessionManager.appendMessage({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);

const appendTurn = (sessionManager: SessionManager, prompt: string, response = "Done"): string => {
  sessionManager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
  return appendAssistant(sessionManager, [{ type: "text", text: response }]);
};

const createExtensionContext = (
  cwd: string,
  sessionManager: SessionManager,
  notifications: string[] = [],
): ExtensionContext =>
  ({
    cwd,
    sessionManager,
    hasUI: true,
    isIdle: () => true,
    ui: { notify: (message: string) => notifications.push(message) },
  }) as unknown as ExtensionContext;

const childSessionFile = (sessionDir: string, sourceFile: string): string => {
  const files = fs
    .readdirSync(sessionDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => path.join(sessionDir, file))
    .filter((file) => file !== sourceFile);
  expect(files).toHaveLength(1);
  return files[0]!;
};

const branchRules: ConfigRule[] = [
  {
    name: "delegate",
    when: { metadata: { "execution.tmux": true } },
    sessionBranch: "previousTurn",
    template:
      "Launch `pi --session {{runtime.sessionBranch.pathShell}} -p {{runtime.skillInvocation.shell}}`.",
  },
];

describe("Pi skill loading", () => {
  it("appends instructions during /skill: expansion", async () => {
    const directory = createTempDir();
    const skillPath = path.join(directory, "SKILL.md");
    fs.writeFileSync(skillPath, skill("  execution:\n    tmux: true\n    windowName: review"));
    const { inputHandler } = setupExtension(skillPath);

    const result = await inputHandler(
      {
        type: "input",
        text: "/skill:code-review inspect this",
        source: "interactive",
      },
      createExtensionContext(directory, SessionManager.inMemory(directory)),
    );

    expect(result).toEqual({
      action: "transform",
      text: `<skill name="code-review" location="${skillPath}">\nReferences are relative to ${directory}.\n\n# Review\n\nReview the changes.\n\nUse tmux window review.\n</skill>\n\ninspect this`,
    });
  });

  it("appends instructions to read-tool skill content", async () => {
    const directory = createTempDir();
    const skillPath = path.join(directory, "SKILL.md");
    const content = skill("  execution:\n    tmux: true\n    windowName: review");
    fs.writeFileSync(skillPath, content);
    const { toolCallHandler, toolResultHandler } = setupExtension(skillPath);
    const sessionManager = SessionManager.inMemory(directory);
    sessionManager.appendMessage({ role: "user", content: "Review this", timestamp: Date.now() });
    const ctx = { cwd: directory, sessionManager } as unknown as ExtensionContext;

    await toolCallHandler(
      { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: skillPath } },
      ctx,
    );
    const result = await toolResultHandler(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: skillPath },
        content: [{ type: "text", text: content }],
        details: undefined,
        isError: false,
      },
      ctx,
    );

    expect(result?.content).toEqual([
      { type: "text", text: `${content}\n\nUse tmux window review.` },
    ]);
  });

  it("preserves normal input and read results for unaffected skills", async () => {
    const directory = createTempDir();
    const skillPath = path.join(directory, "SKILL.md");
    const content = skill("  execution:\n    tmux: false");
    fs.writeFileSync(skillPath, content);
    const { inputHandler, toolCallHandler, toolResultHandler } = setupExtension(skillPath);

    expect(
      await inputHandler(
        { type: "input", text: "/skill:code-review", source: "interactive" },
        createExtensionContext(directory, SessionManager.inMemory(directory)),
      ),
    ).toBeUndefined();
    expect(
      await toolCallHandler(
        { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: skillPath } },
        { cwd: directory } as ExtensionContext,
      ),
    ).toBeUndefined();
    expect(
      await toolResultHandler(
        {
          type: "tool_result",
          toolCallId: "read-1",
          toolName: "read",
          input: { path: skillPath },
          content: [{ type: "text", text: content }],
          details: undefined,
          isError: false,
        },
        { cwd: directory } as ExtensionContext,
      ),
    ).toBeUndefined();
  });
});

describe("previous-turn session branches", () => {
  const historyCases = [
    {
      name: "plain history",
      build: (sessionManager: SessionManager) => appendTurn(sessionManager, "Earlier request"),
    },
    {
      name: "tool-heavy history",
      build: (sessionManager: SessionManager) => {
        sessionManager.appendMessage({ role: "user", content: "Use tools", timestamp: Date.now() });
        appendAssistant(
          sessionManager,
          [
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "README.md" },
            },
          ],
          "toolUse",
        );
        sessionManager.appendMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "contents" }],
          isError: false,
          timestamp: Date.now(),
        });
        return appendAssistant(sessionManager, [{ type: "text", text: "Finished" }]);
      },
    },
    {
      name: "active branch history",
      build: (sessionManager: SessionManager) => {
        const sharedLeaf = appendTurn(sessionManager, "Shared request");
        appendTurn(sessionManager, "Abandoned request");
        sessionManager.branch(sharedLeaf);
        return appendTurn(sessionManager, "Active request");
      },
    },
    {
      name: "compacted history",
      build: (sessionManager: SessionManager) => {
        const firstKeptEntryId = sessionManager.appendMessage({
          role: "user",
          content: "Long request",
          timestamp: Date.now(),
        });
        appendAssistant(sessionManager, [{ type: "text", text: "Long response" }]);
        return sessionManager.appendCompaction("Earlier work summary", firstKeptEntryId, 50_000);
      },
    },
  ];

  testCases.each(historyCases)("branches $name without changing the source", async ({ build }) => {
    const directory = createTempDir();
    const sessionDir = path.join(directory, "sessions'quoted");
    const skillPath = path.join(directory, "SKILL.md");
    fs.writeFileSync(skillPath, skill("  execution:\n    tmux: true\n    windowName: review"));
    const sessionManager = SessionManager.create(directory, sessionDir);
    build(sessionManager);
    const sourceFile = sessionManager.getSessionFile()!;
    const sourceBefore = fs.readFileSync(sourceFile, "utf8");
    const expectedIds = sessionManager.getBranch().map((entry) => entry.id);
    const { inputHandler } = setupExtension(skillPath, branchRules);

    const result = await inputHandler(
      {
        type: "input",
        text: "/skill:code-review inspect Richard's change",
        source: "interactive",
      },
      createExtensionContext(directory, sessionManager),
    );

    const childFile = childSessionFile(sessionDir, sourceFile);
    const childIds = SessionManager.open(childFile)
      .getBranch()
      .map((entry) => entry.id);
    expect(childIds).toEqual(expectedIds);
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceBefore);
    expect(result).toMatchObject({ action: "transform" });
    if (result?.action === "transform") {
      expect(result.text).toContain(`pi --session ${shellQuote(childFile)}`);
      expect(result.text).toContain(
        `-p ${shellQuote("/skill:code-review inspect Richard's change")}`,
      );
      expect(result.text).not.toContain("pi --fork");
    }
  });

  it("creates one branch for multiple matching branch-enabled rules", async () => {
    const directory = createTempDir();
    const sessionDir = path.join(directory, "sessions");
    const skillPath = path.join(directory, "SKILL.md");
    fs.writeFileSync(skillPath, skill("  execution:\n    tmux: true\n    windowName: review"));
    const sessionManager = SessionManager.create(directory, sessionDir);
    appendTurn(sessionManager, "Earlier request");
    const sourceFile = sessionManager.getSessionFile()!;
    const { inputHandler } = setupExtension(skillPath, [
      ...branchRules,
      {
        name: "delegate-again",
        when: { metadata: { "execution.tmux": true } },
        sessionBranch: "previousTurn",
        template: "Reuse {{runtime.sessionBranch.pathShell}}.",
      },
    ]);

    const result = await inputHandler(
      { type: "input", text: "/skill:code-review inspect this", source: "interactive" },
      createExtensionContext(directory, sessionManager),
    );

    const childFile = childSessionFile(sessionDir, sourceFile);
    if (result?.action === "transform") {
      expect(result.text).toContain(`pi --session ${shellQuote(childFile)}`);
      expect(result.text).toContain(`Reuse ${shellQuote(childFile)}`);
    }
  });

  it("reuses the direct invocation branch when the agent reads that skill", async () => {
    const directory = createTempDir();
    const sessionDir = path.join(directory, "sessions");
    const skillPath = path.join(directory, "SKILL.md");
    const content = skill("  execution:\n    tmux: true\n    windowName: review");
    fs.writeFileSync(skillPath, content);
    const sessionManager = SessionManager.create(directory, sessionDir);
    appendTurn(sessionManager, "Earlier request");
    const sourceFile = sessionManager.getSessionFile()!;
    const { inputHandler, toolCallHandler, toolResultHandler } = setupExtension(
      skillPath,
      branchRules,
    );
    const ctx = createExtensionContext(directory, sessionManager);
    const invocation = "/skill:code-review inspect Richard's change";

    const inputResult = await inputHandler(
      { type: "input", text: invocation, source: "interactive" },
      ctx,
    );
    if (inputResult?.action !== "transform") throw new Error("Expected transformed skill input");
    const firstChild = childSessionFile(sessionDir, sourceFile);
    sessionManager.appendMessage({
      role: "user",
      content: inputResult.text,
      timestamp: Date.now(),
    });
    appendAssistant(
      sessionManager,
      [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: skillPath } }],
      "toolUse",
    );

    await toolCallHandler(
      { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: skillPath } },
      ctx,
    );
    const readResult = await toolResultHandler(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: skillPath },
        content: [{ type: "text", text: content }],
        details: undefined,
        isError: false,
      },
      ctx,
    );

    expect(childSessionFile(sessionDir, sourceFile)).toBe(firstChild);
    expect(readResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(`-p ${shellQuote(invocation)}`),
    });
  });

  it("branches read-loaded skills before the active user and assistant work", async () => {
    const directory = createTempDir();
    const sessionDir = path.join(directory, "sessions");
    const skillPath = path.join(directory, "SKILL.md");
    const content = skill("  execution:\n    tmux: true\n    windowName: review");
    fs.writeFileSync(skillPath, content);
    const sessionManager = SessionManager.create(directory, sessionDir);
    const previousLeaf = appendTurn(sessionManager, "Earlier request");
    sessionManager.appendMessage({
      role: "user",
      content: "Search Richard's topic",
      timestamp: Date.now(),
    });
    appendAssistant(
      sessionManager,
      [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: skillPath } }],
      "toolUse",
    );
    const sourceFile = sessionManager.getSessionFile()!;
    const sourceBefore = fs.readFileSync(sourceFile, "utf8");
    const { toolCallHandler, toolResultHandler } = setupExtension(skillPath, branchRules);
    const ctx = createExtensionContext(directory, sessionManager);

    const callResult = await toolCallHandler(
      { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: skillPath } },
      ctx,
    );
    const result = await toolResultHandler(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: skillPath },
        content: [{ type: "text", text: content }],
        details: undefined,
        isError: false,
      },
      ctx,
    );

    expect(callResult).toBeUndefined();
    const childFile = childSessionFile(sessionDir, sourceFile);
    expect(SessionManager.open(childFile).getLeafId()).toBe(previousLeaf);
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceBefore);
    expect(result?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        `-p ${shellQuote("/skill:code-review Search Richard's topic")}`,
      ),
    });
  });

  it("creates an empty child session for a first-turn skill invocation", async () => {
    const directory = createTempDir();
    const sessionDir = path.join(directory, "sessions");
    const skillPath = path.join(directory, "SKILL.md");
    fs.writeFileSync(skillPath, skill("  execution:\n    tmux: true\n    windowName: review"));
    const sessionManager = SessionManager.create(directory, sessionDir);
    sessionManager.appendModelChange("openai", "test-model");
    const sourceFile = sessionManager.getSessionFile()!;
    const { inputHandler } = setupExtension(skillPath, branchRules);

    const result = await inputHandler(
      { type: "input", text: "/skill:code-review inspect this", source: "interactive" },
      createExtensionContext(directory, sessionManager),
    );

    const childFile = childSessionFile(sessionDir, sourceFile);
    const child = SessionManager.open(childFile);
    expect(result).toMatchObject({ action: "transform" });
    expect(child.getBranch()).toEqual([]);
    expect(child.getHeader()?.parentSession).toBe(sourceFile);
    expect(fs.existsSync(sourceFile)).toBe(false);
  });

  it("creates an empty child when a skill is read during the first turn", async () => {
    const directory = createTempDir();
    const sessionDir = path.join(directory, "sessions");
    const skillPath = path.join(directory, "SKILL.md");
    const content = skill("  execution:\n    tmux: true\n    windowName: review");
    fs.writeFileSync(skillPath, content);
    const sessionManager = SessionManager.create(directory, sessionDir);
    sessionManager.appendModelChange("openai", "test-model");
    sessionManager.appendMessage({ role: "user", content: "Research this", timestamp: Date.now() });
    appendAssistant(
      sessionManager,
      [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: skillPath } }],
      "toolUse",
    );
    const sourceFile = sessionManager.getSessionFile()!;
    const sourceBefore = fs.readFileSync(sourceFile, "utf8");
    const { toolCallHandler, toolResultHandler } = setupExtension(skillPath, branchRules);
    const ctx = createExtensionContext(directory, sessionManager);

    const callResult = await toolCallHandler(
      { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: skillPath } },
      ctx,
    );
    const result = await toolResultHandler(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: skillPath },
        content: [{ type: "text", text: content }],
        details: undefined,
        isError: false,
      },
      ctx,
    );

    const childFile = childSessionFile(sessionDir, sourceFile);
    const child = SessionManager.open(childFile);
    expect(callResult).toBeUndefined();
    expect(result?.content[0]).toMatchObject({ type: "text" });
    expect(child.getBranch()).toEqual([]);
    expect(child.getHeader()?.parentSession).toBe(sourceFile);
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceBefore);
  });

  testCases.each([
    {
      name: "ephemeral session",
      createSession: (directory: string) => {
        const sessionManager = SessionManager.inMemory(directory);
        appendTurn(sessionManager, "Earlier request");
        return sessionManager;
      },
    },
    {
      name: "incomplete previous conversation",
      createSession: (directory: string) => {
        const sessionManager = SessionManager.create(directory, path.join(directory, "sessions"));
        sessionManager.appendMessage({
          role: "user",
          content: "Unanswered request",
          timestamp: Date.now(),
        });
        return sessionManager;
      },
    },
  ])("fails clearly for $name", async ({ createSession }) => {
    const directory = createTempDir();
    const skillPath = path.join(directory, "SKILL.md");
    fs.writeFileSync(skillPath, skill("  execution:\n    tmux: true\n    windowName: review"));
    const notifications: string[] = [];
    const { inputHandler } = setupExtension(skillPath, branchRules);

    const result = await inputHandler(
      { type: "input", text: "/skill:code-review inspect this", source: "interactive" },
      createExtensionContext(directory, createSession(directory), notifications),
    );

    expect(result).toEqual({ action: "handled" });
    expect(notifications).toEqual([
      "Session branching requires a persisted previous completed turn.",
    ]);
  });
});
