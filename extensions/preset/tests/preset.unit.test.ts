import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PresetSchema,
  preset,
  resolveInstructionsPath,
  resolveOptions,
  resolvePresetInstructions,
  type PresetOptions,
} from "../src/extension";

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-instructions-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type BeforeAgentStartHandler = (
  event: { systemPrompt: string },
  ctx: ExtensionContext,
) => Promise<{ systemPrompt?: string } | undefined>;

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

type Harness = {
  beforeAgentStart: BeforeAgentStartHandler;
  command: CommandHandler;
  notify: ReturnType<typeof vi.fn>;
  ctx: ExtensionContext;
};

const createHarness = (options: PresetOptions): Harness => {
  const notify = vi.fn();
  const ctx = {
    ui: {
      notify,
      setStatus: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  let beforeAgentStart: BeforeAgentStartHandler | undefined;
  let command: CommandHandler | undefined;

  const pi = {
    registerFlag: vi.fn(),
    registerShortcut: vi.fn(),
    registerCommand: (_name: string, registered: { handler: CommandHandler }) => {
      command = registered.handler;
    },
    on: (event: string, registered: BeforeAgentStartHandler) => {
      if (event === "before_agent_start") beforeAgentStart = registered;
    },
    getThinkingLevel: () => "medium",
    getActiveTools: () => [],
    setActiveTools: vi.fn(),
    setThinkingLevel: vi.fn(),
    getAllTools: () => [],
    setModel: vi.fn().mockResolvedValue(true),
    getFlag: () => undefined,
  } as unknown as ExtensionAPI;

  preset(options)(pi);

  if (!beforeAgentStart || !command) {
    throw new Error("preset extension did not register its handlers");
  }

  return { beforeAgentStart, command, notify, ctx };
};

const warningCalls = (notify: ReturnType<typeof vi.fn>): string[] =>
  notify.mock.calls.filter(([, level]) => level === "warning").map(([message]) => String(message));

describe("resolveInstructionsPath", () => {
  it("resolves relative paths against the base dir", () => {
    expect(resolveInstructionsPath("prompts/plan.md", path.resolve("/config"))).toBe(
      path.resolve("/config", "prompts/plan.md"),
    );
  });

  it("keeps absolute paths unchanged", () => {
    const absolute = path.resolve("/tmp", "plan.md");
    expect(resolveInstructionsPath(absolute, path.resolve("/config"))).toBe(absolute);
  });

  it("expands a leading home directory", () => {
    expect(resolveInstructionsPath("~/prompts/plan.md", path.resolve("/config"))).toBe(
      path.join(os.homedir(), "prompts/plan.md"),
    );
  });
});

describe("resolvePresetInstructions", () => {
  it("returns inline instructions when no file is configured", () => {
    expect(resolvePresetInstructions({ instructions: "inline" }, process.cwd())).toEqual({
      text: "inline",
      error: undefined,
    });
  });

  it("reads file contents relative to the base dir", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "plan.md"), "from file", "utf8");

    expect(resolvePresetInstructions({ instructionsFile: "plan.md" }, dir)).toEqual({
      text: "from file",
      error: undefined,
    });
  });

  it("appends inline instructions after file contents", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "plan.md"), "from file", "utf8");

    expect(
      resolvePresetInstructions({ instructionsFile: "plan.md", instructions: "inline" }, dir),
    ).toEqual({ text: "from file\n\ninline", error: undefined });
  });

  it("warns and falls back to inline instructions when the file is missing", () => {
    const dir = makeTempDir();
    const result = resolvePresetInstructions(
      { instructionsFile: "missing.md", instructions: "inline" },
      dir,
    );

    expect(result.text).toBe("inline");
    expect(result.error).toContain("missing.md");
  });

  it("warns and returns no text when the file is missing and no inline text exists", () => {
    const dir = makeTempDir();
    const result = resolvePresetInstructions({ instructionsFile: "missing.md" }, dir);

    expect(result.text).toBeUndefined();
    expect(result.error).toContain("missing.md");
  });
});

describe("resolveOptions", () => {
  it("defaults instructionsBaseDir to the current working directory", () => {
    expect(resolveOptions().instructionsBaseDir).toBe(process.cwd());
  });

  it("preserves an explicit instructionsBaseDir", () => {
    expect(resolveOptions({ instructionsBaseDir: "/config" }).instructionsBaseDir).toBe("/config");
  });

  it("accepts instructionsFile presets", () => {
    const options = resolveOptions({ presets: { plan: { instructionsFile: "plan.md" } } });
    expect(options.presets.plan?.instructionsFile).toBe("plan.md");
  });
});

describe("PresetSchema", () => {
  it("accepts instructions, instructionsFile, or both", () => {
    expect(PresetSchema.safeParse({ instructions: "inline" }).success).toBe(true);
    expect(PresetSchema.safeParse({ instructionsFile: "plan.md" }).success).toBe(true);
    expect(
      PresetSchema.safeParse({ instructions: "inline", instructionsFile: "plan.md" }).success,
    ).toBe(true);
  });
});

describe("before_agent_start", () => {
  it("appends file instructions to the system prompt", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "plan.md"), "from file", "utf8");
    const harness = createHarness({
      presets: { plan: { instructionsFile: "plan.md" } },
      instructionsBaseDir: dir,
    });

    await harness.command("plan", harness.ctx);
    const result = await harness.beforeAgentStart({ systemPrompt: "base" }, harness.ctx);

    expect(result?.systemPrompt).toBe("base\n\nfrom file");
  });

  it("appends inline instructions after file contents", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "plan.md"), "from file", "utf8");
    const harness = createHarness({
      presets: { plan: { instructionsFile: "plan.md", instructions: "inline" } },
      instructionsBaseDir: dir,
    });

    await harness.command("plan", harness.ctx);
    const result = await harness.beforeAgentStart({ systemPrompt: "base" }, harness.ctx);

    expect(result?.systemPrompt).toBe("base\n\nfrom file\n\ninline");
  });

  it("still appends inline-only instructions", async () => {
    const harness = createHarness({
      presets: { plan: { instructions: "inline only" } },
    });

    await harness.command("plan", harness.ctx);
    const result = await harness.beforeAgentStart({ systemPrompt: "base" }, harness.ctx);

    expect(result?.systemPrompt).toBe("base\n\ninline only");
  });

  it("re-reads the file on each turn", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "plan.md");
    fs.writeFileSync(filePath, "first", "utf8");
    const harness = createHarness({
      presets: { plan: { instructionsFile: "plan.md" } },
      instructionsBaseDir: dir,
    });

    await harness.command("plan", harness.ctx);
    const first = await harness.beforeAgentStart({ systemPrompt: "base" }, harness.ctx);
    expect(first?.systemPrompt).toBe("base\n\nfirst");

    fs.writeFileSync(filePath, "second", "utf8");
    const second = await harness.beforeAgentStart({ systemPrompt: "base" }, harness.ctx);
    expect(second?.systemPrompt).toBe("base\n\nsecond");
  });

  it("warns once per missing file and leaves the prompt unchanged", async () => {
    const dir = makeTempDir();
    const harness = createHarness({
      presets: { plan: { instructionsFile: "missing.md" } },
      instructionsBaseDir: dir,
    });

    await harness.command("plan", harness.ctx);
    const result = await harness.beforeAgentStart({ systemPrompt: "base" }, harness.ctx);

    expect(result).toBeUndefined();
    expect(warningCalls(harness.notify)).toHaveLength(1);
    expect(warningCalls(harness.notify)[0]).toContain("missing.md");

    await harness.beforeAgentStart({ systemPrompt: "base" }, harness.ctx);
    expect(warningCalls(harness.notify)).toHaveLength(1);
  });

  it("does nothing when no preset is active", async () => {
    const harness = createHarness({ presets: { plan: { instructions: "inline" } } });

    const result = await harness.beforeAgentStart({ systemPrompt: "base" }, harness.ctx);

    expect(result).toBeUndefined();
    expect(harness.notify).not.toHaveBeenCalled();
  });
});
