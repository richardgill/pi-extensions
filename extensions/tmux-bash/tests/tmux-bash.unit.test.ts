import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { formatTmuxOutputForContext } from "../src/extension.js";

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
});
