import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  displayCommandForCommand,
  formatCompletionSummary,
  formatEnvironmentExportsForBash,
  formatRenderedBashCall,
  formatRenderedBashResult,
  formatRenderedCompletionMessage,
  formatTmuxOutputForContext,
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

  it("formats background completion summaries name first", () => {
    const result = formatCompletionSummary("sleep-90-hello", 5, 0);

    expect(result).toBe("sleep-90-hello completed successfully in tmux window :5");
  });

  it("formats background failure summaries name first", () => {
    const result = formatCompletionSummary("local-ci", 7, 2);

    expect(result).toBe("local-ci exited with code 2 in tmux window :7");
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

    expect(result).toBe('$ sleep 90 && echo "hello"  bg');
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

  it("renders compact completion messages with output", () => {
    const raw = [
      "sleep-hello completed successfully in tmux window :5.",
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
