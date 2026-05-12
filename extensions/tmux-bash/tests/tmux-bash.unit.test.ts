import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  formatCompletionSummary,
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
});
