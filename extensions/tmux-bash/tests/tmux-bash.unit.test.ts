import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveOptions } from "../src/config";
import { tmuxBash } from "../src/extension";
import {
  displayCommandForCommand,
  formatCompletionSummary,
  formatDurationSeconds,
  formatRenderedBashCall,
  formatRenderedBashResult,
  formatRenderedCompletionMessage,
  formatRenderedPollMessage,
  formatTmuxOutputForContext,
  limitOutputLines,
  renderBackgroundBashResultText,
  renderBashCallText,
  renderBashResultText,
} from "../src/render";
import { formatEnvironmentExportsForBash } from "../src/runtime";
import { tmuxWindowAttachCommand } from "../src/tmux-utils";

type FormatOutputCase = {
  name: string;
  content: string;
  fullOutputPath?: string;
  showFullOutputPath?: boolean;
  truncationOptions?: { maxBytes?: number; maxLines?: number };
  expectedText: string;
  expectedFullOutputPath?: string;
  expectedTruncation?: {
    truncated: boolean;
    truncatedBy?: "bytes" | "lines";
    outputLines: number;
    totalLines: number;
  };
};

const plainTheme = {
  bold: (text: string) => text,
  fg: (_name: string, text: string) => text,
};

type RegisteredTool = {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  promptGuidelines?: string[];
};

const registeredToolsForOptions = (options: Parameters<typeof tmuxBash>[0]): RegisteredTool[] => {
  const tools: RegisteredTool[] = [];
  const pi = {
    on: () => {},
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;

  tmuxBash(options)(pi);
  return tools;
};

const registeredTool = (tools: RegisteredTool[], name: string): RegisteredTool => {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`${name} tool was not registered`);
  return tool;
};

const taggedTheme = {
  bold: (text: string) => `<bold>${text}</bold>`,
  fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
};

const setDefaultKeybindings = (): void => {
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    }),
  );
};

describe("tmux-bash unit", () => {
  beforeEach(setDefaultKeybindings);

  describe("formatTmuxOutputForContext", () => {
    const fullOutputPath = "/tmp/pi-tmux-bash-full.log";

    const cases: FormatOutputCase[] = [
      {
        name: "truncates oversized output before returning it to model context",
        content: "start\nmiddle\nend",
        fullOutputPath,
        truncationOptions: { maxBytes: 12 },
        expectedText: `middle\nend\n\n[Showing lines 2-3 of 3 (12B limit). Full output: ${fullOutputPath}]`,
        expectedFullOutputPath: fullOutputPath,
        expectedTruncation: {
          truncated: true,
          truncatedBy: "bytes",
          outputLines: 2,
          totalLines: 3,
        },
      },
      {
        name: "keeps small output unchanged",
        content: "hello",
        expectedText: "hello",
      },
      {
        name: "matches vanilla bash for a single output line over the byte limit",
        content: "abcdefghijk\n",
        fullOutputPath,
        truncationOptions: { maxBytes: 5 },
        expectedText: `ghijk\n\n[Showing last 5B of line 1 (line is 0B). Full output: ${fullOutputPath}]`,
        expectedFullOutputPath: fullOutputPath,
        expectedTruncation: {
          truncated: true,
          outputLines: 1,
          totalLines: 1,
        },
      },
      {
        name: "can include full output paths for small output",
        content: "hello",
        fullOutputPath: "/tmp/output.out",
        showFullOutputPath: true,
        expectedText: "hello\n\n[Full output: /tmp/output.out]",
        expectedFullOutputPath: "/tmp/output.out",
      },
    ];

    it.each(cases)("$name", (testCase) => {
      const result = formatTmuxOutputForContext(testCase.content, {
        fullOutputPath: testCase.fullOutputPath,
        emptyText: "(no output)",
        showFullOutputPath: testCase.showFullOutputPath,
        truncationOptions: testCase.truncationOptions,
      });

      expect(result.text).toBe(testCase.expectedText);
      expect(result.details?.fullOutputPath).toBe(testCase.expectedFullOutputPath);

      if (testCase.expectedTruncation) {
        expect(result.details?.truncation).toMatchObject(testCase.expectedTruncation);
      } else {
        expect(result.details?.truncation).toBeUndefined();
      }
    });
  });

  describe("limitOutputLines", () => {
    it("limits output to the latest requested lines", () => {
      const content = ["line-1", "line-2", "line-3", "line-4"].join("\n") + "\n";

      expect(limitOutputLines(content, 2)).toBe("line-3\nline-4");
    });
  });

  describe("resolveOptions", () => {
    it("resolves new tmux scope configuration", () => {
      const result = resolveOptions({
        gitRootTmuxSessionNameTemplate: "git-{{gitRootSessionName}}",
        tmuxSessionScope: "git-root",
        globalTmuxSessionName: "global-bg",
        tmuxWindowScope: "all",
        bashToolName: "shell",
        tmuxToolName: "mux",
        bashToolDescription: "Run {{bashToolName}}: {{bashContextLines}}/{{maxOutputKb}}",
        tmuxToolDescription: "Inspect {{tmuxToolName}}",
        tmuxBinary: "/opt/bin/tmux",
        tmuxEnvExportDenylist: ["CUSTOM"],
        foregroundBashUpdateIntervalMs: 100,
        bashContextLines: 123,
        tmuxWindowNameTemplate: "bg-{{nameOrCommand}}",
        maxTmuxWindowNameLength: 42,
        maxOutputBytes: 456,
      });

      expect(result.gitRootTmuxSessionNameTemplate).toBe("git-{{gitRootSessionName}}");
      expect(result.tmuxSessionScope).toBe("git-root");
      expect(result.globalTmuxSessionName).toBe("global-bg");
      expect(result.tmuxWindowScope).toBe("all");
      expect(result.bashToolName).toBe("shell");
      expect(result.tmuxToolName).toBe("mux");
      expect(result.bashToolDescription).toBe(
        "Run {{bashToolName}}: {{bashContextLines}}/{{maxOutputKb}}",
      );
      expect(result.tmuxToolDescription).toBe("Inspect {{tmuxToolName}}");
      expect(result.tmuxBinary).toBe("/opt/bin/tmux");
      expect(result.tmuxEnvExportDenylist).toEqual(["CUSTOM"]);
      expect(result.foregroundBashUpdateIntervalMs).toBe(100);
      expect(result.bashContextLines).toBe(123);
      expect(result.tmuxWindowNameTemplate).toBe("bg-{{nameOrCommand}}");
      expect(result.maxTmuxWindowNameLength).toBe(42);
      expect(result.maxOutputBytes).toBe(456);
    });
  });

  describe("tool registration", () => {
    it("omits tmux tool when all tmux actions are disabled", () => {
      const tools = registeredToolsForOptions({ tmuxEnabledActions: [] });

      expect(tools.map((tool) => tool.name)).toEqual(["bash"]);
    });

    it("registers tmux tool with default actions only", () => {
      const tools = registeredToolsForOptions({});
      const tmuxTool = registeredTool(tools, "tmux");
      const action = tmuxTool.parameters.properties?.action as { enum?: string[] };

      expect(action.enum).toEqual(["list", "peek", "kill"]);
      expect(tmuxTool.promptGuidelines?.join("\n")).toContain("tmux peek/kill");
      expect(tmuxTool.promptGuidelines?.join("\n")).not.toContain("poll/unpoll");
    });

    it("registers tmux tool with configured actions only", () => {
      const tools = registeredToolsForOptions({ tmuxEnabledActions: ["peek", "kill"] });
      const tmuxTool = registeredTool(tools, "tmux");
      const action = tmuxTool.parameters.properties?.action as { enum?: string[] };

      expect(action.enum).toEqual(["peek", "kill"]);
      expect(tmuxTool.promptGuidelines?.join("\n")).toContain("tmux peek/kill");
    });

    it("removes bash polling parameters by default", () => {
      const tools = registeredToolsForOptions({});
      const bashTool = registeredTool(tools, "bash");

      expect(bashTool.parameters.properties).not.toHaveProperty("pollInterval");
      expect(bashTool.parameters.properties).not.toHaveProperty("pollLines");
      expect(bashTool.promptGuidelines?.join("\n")).not.toContain("pollInterval");
    });
  });

  describe("tmuxWindowAttachCommand", () => {
    it("formats attach commands for the current environment", () => {
      expect(tmuxWindowAttachCommand("@1065", { TMUX: "/tmp/tmux" }, "tmux")).toBe(
        "tmux switch-client -t @1065",
      );
      expect(tmuxWindowAttachCommand("@1065", {}, "tmux")).toBe("tmux attach -t @1065");
      expect(tmuxWindowAttachCommand("@1065", {}, "/opt/bin/tmux")).toBe(
        "'/opt/bin/tmux' attach -t @1065",
      );
    });
  });

  describe("formatCompletionSummary", () => {
    it.each([
      { exitCode: 0, expected: "Background bash finished" },
      { exitCode: 2, expected: "Background bash failed" },
    ])("formats exit code $exitCode", ({ exitCode, expected }) => {
      expect(formatCompletionSummary(exitCode)).toBe(expected);
    });
  });

  describe("bash rendering", () => {
    it("hides full output paths from collapsed bash results", () => {
      const result = formatTmuxOutputForContext("hello", {
        fullOutputPath: "/tmp/output.out",
        showFullOutputPath: true,
      });

      expect(formatRenderedBashResult(result.details.render, { expanded: false })).toBe("hello");
    });

    it("keeps full output paths in expanded bash results", () => {
      const result = formatTmuxOutputForContext("hello", {
        fullOutputPath: "/tmp/output.out",
        showFullOutputPath: true,
      });

      expect(formatRenderedBashResult(result.details.render, { expanded: true })).toBe(
        "hello\n\n[Full output: /tmp/output.out]",
      );
    });

    it("renders compact bash calls with useful metadata", () => {
      const result = formatRenderedBashCall({
        command: 'sleep 90 && echo "hello"',
        background: true,
      });

      expect(result).toBe('$ sleep 90 && echo "hello" (background)');
    });

    it("renders background bash start output with a blank line after the call", () => {
      const call = formatRenderedBashCall({
        command: "sleep 90",
        background: true,
      });
      const result = renderBackgroundBashResultText({
        raw: "Started in background tmux window: sleep @1065.\nResult will be reported when it finishes.\n\nAttach with: tmux switch-client -t @1065",
        expanded: false,
        theme: plainTheme,
      });

      expect(`${call}\n${result}`).toBe(
        "$ sleep 90 (background)\n\nStarted in background tmux window: sleep @1065.\nResult will be reported when it finishes.\n\nAttach with: tmux switch-client -t @1065",
      );
    });

    it("does not render timeout metadata for immediately-backgrounded bash calls", () => {
      const result = formatRenderedBashCall({
        command: "sleep 90",
        background: true,
        timeout: 1,
      });

      expect(result).toBe("$ sleep 90 (background)");
    });

    it("renders background poll metadata in the same brackets", () => {
      const result = formatRenderedBashCall({
        command: "sleep 90",
        background: true,
        pollInterval: 30,
      });

      expect(result).toBe("$ sleep 90 (background, poll 30s)");
    });

    it("formats bash durations as whole seconds", () => {
      expect(formatDurationSeconds(5_000)).toBe("5s");
      expect(formatDurationSeconds(10_000)).toBe("10s");
      expect(formatDurationSeconds(10_900)).toBe("10s");
    });

    it("renders elapsed with one visible blank line after output", () => {
      const result = renderBashResultText({
        raw: "working",
        expanded: false,
        isPartial: true,
        state: { startedAt: 0, endedAt: 5_000 },
        theme: plainTheme,
      });

      expect(result).toBe(`working

Elapsed 5.0s`);
    });

    it("renders elapsed with one visible blank line when there is no output yet", () => {
      const result = renderBashResultText({
        raw: "",
        expanded: false,
        isPartial: true,
        state: { startedAt: 0, endedAt: 5_000 },
        theme: plainTheme,
      });

      expect(result).toBe(`
Elapsed 5.0s`);
    });

    it("renders took with one visible blank line after output", () => {
      const result = renderBashResultText({
        raw: "done",
        expanded: false,
        isPartial: false,
        state: { startedAt: 0, endedAt: 5_000 },
        theme: plainTheme,
      });

      expect(result).toBe(`done

Took 5.0s`);
    });

    it("renders collapsed bash elision with vanilla pi colors", () => {
      const output = formatTmuxOutputForContext(
        "line-1\nline-2\nline-3\nline-4\nline-5\nline-6\nline-7",
        {
          fullOutputPath: "/tmp/output.out",
          truncationOptions: { maxLines: 6 },
        },
      );
      const result = renderBashResultText({
        raw: output.text,
        details: output.details.render,
        expanded: false,
        isPartial: false,
        state: {},
        theme: taggedTheme,
      });

      expect(result).toContain(
        "<muted>... (4 earlier lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted>)",
      );
      expect(result).toContain("<toolOutput>line-7</toolOutput>");
      expect(result).toContain(
        "<toolOutput>[Showing lines 2-7 of 7. Full output: /tmp/output.out]</toolOutput>",
      );
    });

    it("renders timeout metadata like the built-in bash tool", () => {
      const result = formatRenderedBashCall({
        command: 'sleep 10 && echo "done"',
        timeout: 15,
      });

      expect(result).toBe('$ sleep 10 && echo "done" (timeout 15s)');
    });

    it("renders timeout metadata muted, not as part of the bash title", () => {
      const result = renderBashCallText({ command: "sleep 10", timeout: 15 }, taggedTheme);

      expect(result).toBe(
        "<toolTitle><bold>$ sleep 10</bold></toolTitle><muted> (timeout 15s)</muted>",
      );
    });
  });

  describe("displayCommandForCommand", () => {
    it("strips command wrappers using the display marker", () => {
      const command = [
        "export __PI_FILE_LINE_TRACKER_EVENTS='/tmp/events.jsonl'",
        "cat() {",
        '  command cat "$@"',
        "}",
        "# SHIM_END",
        "gh pr checks 2371",
      ].join("\n");

      expect(displayCommandForCommand(command)).toBe("gh pr checks 2371");
    });

    it("uses the last display marker", () => {
      const command = ["outer", "# SHIM_END", "inner", "# SHIM_END", "echo hello"].join("\n");

      expect(displayCommandForCommand(command)).toBe("echo hello");
    });

    it("does not strip commands when the display marker is disabled", () => {
      const command = ["wrapper", "# SHIM_END", "echo hello"].join("\n");

      expect(displayCommandForCommand(command, "")).toBe(command);
    });

    it("only strips marker lines", () => {
      const command = "echo '# SHIM_END'";

      expect(displayCommandForCommand(command)).toBe(command);
    });
  });

  describe("formatEnvironmentExportsForBash", () => {
    it("exports pi process environment variables into tmux bash scripts", () => {
      const result = formatEnvironmentExportsForBash({
        MY_ENV_VAR: "7",
        QUOTED_ENV_VAR: "it's ok",
        TMUX: "/tmp/tmux-1000/default,1,0",
        "not-exportable": "skip",
      });

      expect(result).toContain("export MY_ENV_VAR='7'");
      expect(result).toContain("export QUOTED_ENV_VAR='it'\\''s ok'");
      expect(result).not.toContain("TMUX");
      expect(result).not.toContain("not-exportable");
    });

    it("uses the configured environment export denylist", () => {
      const result = formatEnvironmentExportsForBash(
        {
          CUSTOM: "skip",
          PWD: "/tmp/project",
        },
        ["CUSTOM"],
      );

      expect(result).toContain("export PWD='/tmp/project'");
      expect(result).not.toContain("CUSTOM");
    });
  });

  describe("formatRenderedCompletionMessage", () => {
    it("renders compact background bash completion messages", () => {
      const output = formatTmuxOutputForContext("hello", {
        fullOutputPath: "/tmp/output.out",
        showFullOutputPath: true,
      });
      const details = {
        summary: "Background bash finished",
        output: output.details.render,
        exitCode: 0,
        status: "success" as const,
      };

      expect(formatRenderedCompletionMessage({ details, expanded: false })).toBe(
        "Background bash finished\n\n hello",
      );
    });

    it("renders expanded completion messages with one-space indented output", () => {
      const details = {
        summary: "Background bash finished",
        output: formatTmuxOutputForContext("\nhello").details.render,
        exitCode: 0,
        status: "success" as const,
      };

      expect(formatRenderedCompletionMessage({ details, expanded: true })).toBe(
        "Background bash finished\n hello",
      );
    });

    it("hides empty completion output", () => {
      const details = {
        summary: "Background bash finished",
        output: formatTmuxOutputForContext("").details.render,
        exitCode: 0,
        status: "success" as const,
      };

      expect(formatRenderedCompletionMessage({ details, expanded: false })).toBe(
        "Background bash finished",
      );
    });

    it("does not hide real completion output matching the empty placeholder", () => {
      const details = {
        summary: "Background bash finished",
        output: formatTmuxOutputForContext("(no output)").details.render,
        exitCode: 0,
        status: "success" as const,
      };

      expect(formatRenderedCompletionMessage({ details, expanded: false })).toBe(
        "Background bash finished\n\n (no output)",
      );
    });
  });

  describe("formatRenderedPollMessage", () => {
    it("renders poll messages from structured details", () => {
      const details = {
        summary: "tmux poll: poll-fit @1065",
        command: "$ printf 'hello\\n'",
        output: formatTmuxOutputForContext("hello").details.render,
        attachLines: [" Attach with: tmux switch-client -t @1065"],
      };

      expect(formatRenderedPollMessage({ details, expanded: false })).toBe(
        "tmux poll: poll-fit @1065\n\n $ printf 'hello\\n'\n hello\n\n Attach with: tmux switch-client -t @1065",
      );
    });
  });
});
