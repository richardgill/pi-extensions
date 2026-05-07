import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  bashTimeoutGuard,
  createBashPromptMetadata,
  createTimeoutGuardedBashTool,
  DEFAULT_OPTIONS,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  normalizeBashTimeout,
  renderPromptTemplate,
  type BashToolFactory,
} from "../src/extension.js";

const createCtx = (cwd: string): ExtensionContext => ({ cwd }) as ExtensionContext;

const createRecordingFactory = () => {
  const createdCwds: string[] = [];
  const executed: { cwd: string; timeout: number | undefined }[] = [];

  const toolFactory: BashToolFactory = (cwd) => {
    createdCwds.push(cwd);
    return {
      ...createBashTool(cwd),
      execute: async (_toolCallId, params) => {
        executed.push({ cwd, timeout: params.timeout });
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    };
  };

  return { createdCwds, executed, toolFactory };
};

describe("normalizeBashTimeout", () => {
  it("uses the default timeout when omitted", () => {
    expect(normalizeBashTimeout(undefined)).toBe(DEFAULT_TIMEOUT_SECONDS);
  });

  it("rejects fractional timeouts", () => {
    expect(() => normalizeBashTimeout(1.01)).toThrow("positive whole number");
  });

  it("clamps timeouts above the maximum", () => {
    expect(normalizeBashTimeout(MAX_TIMEOUT_SECONDS + 1)).toBe(MAX_TIMEOUT_SECONDS);
  });

  it("rejects non-positive and non-finite values", () => {
    expect(() => normalizeBashTimeout(0)).toThrow("positive whole number");
    expect(() => normalizeBashTimeout(-1)).toThrow("positive whole number");
    expect(() => normalizeBashTimeout(Number.NaN)).toThrow("positive whole number");
  });
});

describe("prompt templating", () => {
  it("renders configured timeout placeholders", () => {
    expect(
      renderPromptTemplate("bash max is {{maxTimeoutSeconds}}s", {
        defaultTimeoutSeconds: 10,
        maxTimeoutSeconds: 20,
        prompt: "",
      }),
    ).toBe("bash max is 20s");
  });

  it("adds configured prompt to bash guidelines", () => {
    expect(
      createBashPromptMetadata({
        defaultTimeoutSeconds: 10,
        maxTimeoutSeconds: 20,
        prompt: "Do not set bash timeout above {{maxTimeoutSeconds}} seconds.",
      }).promptGuidelines,
    ).toContain("Do not set bash timeout above 20 seconds.");
  });
});

describe("createTimeoutGuardedBashTool", () => {
  it("keeps bash prompt metadata model-visible", () => {
    const tool = createTimeoutGuardedBashTool(process.cwd());

    expect(tool.name).toBe("bash");
    expect(tool.promptSnippet).toBe(createBashPromptMetadata(DEFAULT_OPTIONS).promptSnippet);
    expect(tool.promptGuidelines).toEqual(
      createBashPromptMetadata(DEFAULT_OPTIONS).promptGuidelines,
    );
    expect(tool.description).toContain("30 second timeout");
    expect(tool.description).toContain("60 seconds");
    expect(tool.description).toContain("tmux");
  });

  it("delegates execution to createBashTool with ctx.cwd and an adjusted timeout", async () => {
    const { createdCwds, executed, toolFactory } = createRecordingFactory();
    const tool = createTimeoutGuardedBashTool("/initial", { toolFactory });

    await tool.execute(
      "call-id",
      { command: "echo hi", timeout: 2 },
      undefined,
      undefined,
      createCtx("/session"),
    );

    expect(createdCwds).toEqual(["/initial", "/session"]);
    expect(executed).toEqual([{ cwd: "/session", timeout: 2 }]);
  });

  it("adds the default timeout before delegating when timeout is omitted", async () => {
    const { executed, toolFactory } = createRecordingFactory();
    const tool = createTimeoutGuardedBashTool("/initial", { toolFactory });

    await tool.execute(
      "call-id",
      { command: "echo hi" },
      undefined,
      undefined,
      createCtx("/session"),
    );

    expect(executed).toEqual([{ cwd: "/session", timeout: DEFAULT_TIMEOUT_SECONDS }]);
  });

  it("uses configured integer default and max timeouts", async () => {
    const { executed, toolFactory } = createRecordingFactory();
    const tool = createTimeoutGuardedBashTool("/initial", {
      defaultTimeoutSeconds: 10,
      maxTimeoutSeconds: 20,
      toolFactory,
    });

    await tool.execute(
      "call-id-1",
      { command: "echo hi" },
      undefined,
      undefined,
      createCtx("/session"),
    );
    await tool.execute(
      "call-id-2",
      { command: "echo hi", timeout: 30 },
      undefined,
      undefined,
      createCtx("/session"),
    );

    expect(executed).toEqual([
      { cwd: "/session", timeout: 10 },
      { cwd: "/session", timeout: 20 },
    ]);
  });

  it("rejects programmatic options where default timeout exceeds max timeout", () => {
    expect(() =>
      createTimeoutGuardedBashTool("/initial", {
        defaultTimeoutSeconds: 20,
        maxTimeoutSeconds: 10,
      }),
    ).toThrow("defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds");
  });
});

describe("bashTimeoutGuard", () => {
  it("registers a bash tool override", () => {
    const registeredTools: { name: string }[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool);
      },
    } as unknown as ExtensionAPI;

    bashTimeoutGuard()(pi);

    expect(registeredTools.map((tool) => tool.name)).toEqual(["bash"]);
  });
});
