import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  displayCommandForCommand,
  formatCompletionSummary,
  formatDurationSeconds,
  formatEnvironmentExportsForBash,
  formatRenderedBashCall,
  formatRenderedBashResult,
  formatRenderedCompletionMessage,
  formatTmuxOutputForContext,
  limitOutputLines,
  renderBackgroundBashResultText,
  renderBashCallText,
  renderBashResultText,
  resolveOptions,
} from "../src/extension.js";

describe("tmux-bash output truncation", () => {
  it("truncates oversized output before returning it to model context", () => {
    const fullOutputPath = "/tmp/pi-tmux-bash-full.log";
    const content = ["start", "x".repeat(DEFAULT_MAX_BYTES + 100), "end"].join("\n");

    const result = formatTmuxOutputForContext(content, fullOutputPath);

    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.fullOutputPath).toBe(fullOutputPath);
    expect(result.text.length).toBeLessThan(content.length);
    expect(result.text).toContain("end");
    expect(result.text).toContain(`Full output: ${fullOutputPath}`);
  });

  it("keeps small output unchanged", () => {
    const result = formatTmuxOutputForContext("hello");

    expect(result).toEqual({ text: "hello", details: undefined });
  });

  it("limits output to the latest requested lines", () => {
    const content = ["line-1", "line-2", "line-3", "line-4"].join("\n") + "\n";

    expect(limitOutputLines(content, 2)).toBe("line-3\nline-4");
  });

  it("can include full output paths for small output", () => {
    const result = formatTmuxOutputForContext("hello", "/tmp/output.out", "(no output)", true);

    expect(result.text).toContain("hello");
    expect(result.text).toContain("Full output: /tmp/output.out");
    expect(result.details?.fullOutputPath).toBe("/tmp/output.out");
  });

  it("closes completed windows by default", () => {
    expect(DEFAULT_OPTIONS.projectSessionNameTemplate).toBe("{{}}-bg");
    expect(DEFAULT_OPTIONS.sessionScope).toBe("project");
    expect(DEFAULT_OPTIONS.sharedSessionName).toBe("pi-background");
    expect(DEFAULT_OPTIONS.autoCloseWindowsOnCompletion).toBe(true);
    expect(DEFAULT_OPTIONS.alwaysShowOutputFilePath).toBe(false);
    expect(DEFAULT_OPTIONS.preserveOutputFiles).toBe(false);
    expect(DEFAULT_OPTIONS.outputDir).toBe("/tmp/pi-tmux-bash");
    expect(DEFAULT_OPTIONS.displayCommandStartMarker).toBe("# SHIM_END");
  });

  it("keeps sessionNameTemplate as a deprecated alias", () => {
    const result = resolveOptions({ sessionNameTemplate: "legacy-{{}}" });

    expect(result.projectSessionNameTemplate).toBe("legacy-{{}}");
  });

  it("formats background completion summaries with a tmux target line", () => {
    const result = formatCompletionSummary("sleep-90-hello", "pi-background", 5, 0);

    expect(result).toBe(
      'Background job "sleep-90-hello" completed successfully\ntmux: pi-background:5',
    );
  });

  it("formats background failure summaries with a tmux target line", () => {
    const result = formatCompletionSummary("local-ci", "pi-background", 7, 2);

    expect(result).toBe('Background job "local-ci" exited with code 2\ntmux: pi-background:7');
  });

  it("formats background completion summaries with duration", () => {
    const result = formatCompletionSummary("sleep-90", "pi-background", 3, 0, 90_000);

    expect(result).toBe(
      'Background job "sleep-90" completed successfully after 90s\ntmux: pi-background:3',
    );
  });

  it("hides full output paths from collapsed bash results", () => {
    const result = formatRenderedBashResult("hello\n\n[Full output: /tmp/output.out]", false);

    expect(result).toBe("hello");
  });

  it("keeps full output paths in expanded bash results", () => {
    const raw = "hello\n\n[Full output: /tmp/output.out]";

    expect(formatRenderedBashResult(raw, true)).toBe(raw);
  });

  it("renders compact bash calls with useful metadata", () => {
    const result = formatRenderedBashCall({
      command: 'sleep 90 && echo "hello"',
      background: true,
    });

    expect(result).toBe('$ sleep 90 && echo "hello" (background)');
  });

  it("renders background bash start output with a blank line after the call", () => {
    const theme = {
      bold: (text: string) => text,
      fg: (_name: string, text: string) => text,
    };
    const call = formatRenderedBashCall({ command: "sleep 90", background: true });
    const result = renderBackgroundBashResultText(
      "Started in background tmux window.",
      false,
      theme,
    );

    expect(`${call}\n${result}`).toBe(
      "$ sleep 90 (background)\n\nStarted in background tmux window.",
    );
  });

  it("does not render timeout metadata for immediately-backgrounded bash calls", () => {
    const result = formatRenderedBashCall({ command: "sleep 90", background: true, timeout: 1 });

    expect(result).toBe("$ sleep 90 (background)");
  });

  it("formats bash durations as whole seconds", () => {
    expect(formatDurationSeconds(5_000)).toBe("5s");
    expect(formatDurationSeconds(10_000)).toBe("10s");
    expect(formatDurationSeconds(10_900)).toBe("10s");
  });

  it("renders elapsed with one visible blank line after output", () => {
    const theme = {
      bold: (text: string) => text,
      fg: (_name: string, text: string) => text,
    };

    const result = renderBashResultText(
      "working",
      false,
      true,
      { startedAt: 0, endedAt: 5_000 },
      theme,
    );

    expect(result).toBe(`working

Elapsed 5.0s`);
  });

  it("renders elapsed with one visible blank line when there is no output yet", () => {
    const theme = {
      bold: (text: string) => text,
      fg: (_name: string, text: string) => text,
    };

    const result = renderBashResultText("", false, true, { startedAt: 0, endedAt: 5_000 }, theme);

    expect(result).toBe(`
Elapsed 5.0s`);
  });

  it("renders took with one visible blank line after output", () => {
    const theme = {
      bold: (text: string) => text,
      fg: (_name: string, text: string) => text,
    };

    const result = renderBashResultText(
      "done",
      false,
      false,
      { startedAt: 0, endedAt: 5_000 },
      theme,
    );

    expect(result).toBe(`done

Took 5s`);
  });

  it("renders timeout metadata like the built-in bash tool", () => {
    const result = formatRenderedBashCall({
      command: 'sleep 10 && echo "done"',
      timeout: 15,
    });

    expect(result).toBe('$ sleep 10 && echo "done" (timeout 15s)');
  });

  it("renders timeout metadata muted, not as part of the bash title", () => {
    const theme = {
      bold: (text: string) => `<bold>${text}</bold>`,
      fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
    };

    const result = renderBashCallText({ command: "sleep 10", timeout: 15 }, theme);

    expect(result).toBe(
      "<toolTitle><bold>$ sleep 10</bold></toolTitle><muted> (timeout 15s)</muted>",
    );
  });

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

  it("only strips marker lines", () => {
    const command = "echo '# SHIM_END'";

    expect(displayCommandForCommand(command)).toBe(command);
  });

  it("renders compact completion messages with the tmux target line", () => {
    const raw = [
      'Background job "sleep-hello" completed successfully after 90s',
      "tmux: pi-background:5",
      "",
      "```",
      "hello",
      "",
      "[Full output: /tmp/output.out]",
      "```",
    ].join("\n");

    expect(formatRenderedCompletionMessage(raw, false)).toBe(
      'Background job "sleep-hello" completed after 90s\n  tmux: pi-background:5\n  Output: hello',
    );
  });

  it("renders legacy completion messages compactly", () => {
    const raw = [
      'tmux window "sleep-hello" (:5) completed successfully.',
      "",
      "```",
      "hello",
      "",
      "[Full output: /tmp/output.out]",
      "```",
    ].join("\n");

    expect(formatRenderedCompletionMessage(raw, false)).toBe(
      "sleep-hello completed in tmux window :5\nhello",
    );
  });

  it("keeps expanded completion messages unchanged", () => {
    const raw = "sleep-hello completed successfully in tmux window :5.\n\n```\nhello\n```";

    expect(formatRenderedCompletionMessage(raw, true)).toBe(raw);
  });
});
